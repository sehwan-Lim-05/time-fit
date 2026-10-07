-- UIUX-02: grant scoped management access to an existing employee account
-- without changing the employee membership or deleting the employee identity
-- when management access is later revoked.

alter table public.timefit_user_management_accounts
  add column if not exists account_origin text not null default 'standalone'
    check (account_origin in ('standalone','linked_employee'));

do $$
declare constraint_name text;
begin
  for constraint_name in
    select conname from pg_constraint
    where conrelid = 'public.timefit_user_management_permissions'::regclass
      and contype = 'c' and pg_get_constraintdef(oid) like '%permission_code%'
  loop
    execute format('alter table public.timefit_user_management_permissions drop constraint %I', constraint_name);
  end loop;
end $$;

alter table public.timefit_user_management_permissions
  add constraint timefit_user_management_permissions_code_check
  check (permission_code in (
    'dashboard.view','attendance.view','attendance.manage','attendance.review_correction','schedule.view','schedule.manage','schedule.approve','leave.view','leave.review',
    'payroll.view','employee.view','employee.manage','employee.compensation.view','employee.compensation.manage','sales.view','sales.sync','settings.manage','finance.view','expense.manage',
    'expense.receipt.review','expense.card.manage','expense.closeout.manage','expense.export'
  ));

create table if not exists public.timefit_user_management_audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  management_account_id uuid references public.timefit_user_management_accounts(id) on delete set null,
  target_user_id uuid not null references auth.users(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  action text not null check (action in ('created','linked','updated','suspended','reactivated','revoked')),
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);

create index if not exists timefit_management_audit_org_created
  on public.timefit_user_management_audit_logs(organization_id, created_at desc);

alter table public.timefit_user_management_audit_logs enable row level security;
create policy "management audit owner read"
  on public.timefit_user_management_audit_logs for select
  using (public.timefit_user_is_organization_owner(organization_id));

grant select on public.timefit_user_management_audit_logs to authenticated;
grant all on public.timefit_user_management_audit_logs to service_role;

create or replace function public.timefit_user_mobile_bootstrap()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'user_id', auth.uid(),
    'organizations', coalesce(jsonb_agg(
      jsonb_build_object(
        'organization_id', organization.id,
        'organization_name', organization.name,
        'role', case when organization.owner_id = auth.uid() then 'owner' else membership.role::text end,
        'staff_id', staff.id,
        'display_name', coalesce(account.display_name, staff.display_name),
        'department', staff.department,
        'job_title', staff.job_title,
        'management_role_code', management.role_code,
        'management_permissions', coalesce((
          select jsonb_agg(permission.permission_code order by permission.permission_code)
          from public.timefit_user_management_permissions permission
          where permission.management_account_id = management.id and permission.allowed
        ), '[]'::jsonb)
      ) order by organization.name
    ) filter (where organization.id is not null), '[]'::jsonb)
  )
  from public.timefit_user_memberships membership
  join public.timefit_user_organizations organization on organization.id = membership.organization_id
  left join public.timefit_user_staff staff on staff.organization_id = membership.organization_id and staff.user_id = auth.uid()
  left join public.timefit_user_accounts account on account.id = auth.uid()
  left join public.timefit_user_management_accounts management
    on management.organization_id = membership.organization_id
   and management.user_id = auth.uid()
   and management.status = 'active'
  where membership.user_id = auth.uid()
  group by organization.id, organization.name, organization.owner_id, membership.role,
    staff.id, staff.display_name, staff.department, staff.job_title, account.display_name,
    management.id, management.role_code
$$;

revoke all on function public.timefit_user_mobile_bootstrap() from public;
grant execute on function public.timefit_user_mobile_bootstrap() to authenticated;

-- Apply the same delegated approval rules to the existing web RPC.
create or replace function public.timefit_user_review_schedule(
  p_schedule_id uuid, p_decision text, p_comment text default null
) returns public.timefit_user_work_schedules
language plpgsql security definer set search_path=public as $$
declare v_row public.timefit_user_work_schedules;
begin
  if p_decision not in ('approved','rejected') then raise exception 'invalid_schedule_decision'; end if;
  select * into v_row from public.timefit_user_work_schedules where id=p_schedule_id for update;
  if v_row.id is null then raise exception 'schedule_not_found'; end if;
  if not public.timefit_user_is_organization_owner(v_row.organization_id)
    and not (
      public.timefit_user_has_management_permission(v_row.organization_id,'schedule.approve')
      and public.timefit_user_management_can_access_staff(v_row.organization_id,v_row.staff_id)
    ) then raise exception 'schedule_approval_forbidden'; end if;
  update public.timefit_user_work_schedules
  set approval_status=p_decision, reviewed_by=auth.uid(), reviewed_at=now(), review_comment=nullif(trim(p_comment),'')
  where id=p_schedule_id returning * into v_row;
  return v_row;
end $$;

-- Delegated attendance correction stays staff-scoped and keeps the existing
-- optimistic concurrency and audit behavior.
create or replace function public.timefit_user_correct_attendance(
  p_organization_id uuid, p_staff_id uuid, p_work_date date,
  p_checked_in_at timestamptz, p_checked_out_at timestamptz,
  p_reason text, p_expected_updated_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_before public.timefit_user_attendance_records; v_after public.timefit_user_attendance_records;
begin
  if auth.uid() is null or not (
    public.timefit_user_is_organization_owner(p_organization_id)
    or (
      (public.timefit_user_has_management_permission(p_organization_id,'attendance.manage')
       or public.timefit_user_has_management_permission(p_organization_id,'attendance.review_correction'))
      and public.timefit_user_management_can_access_staff(p_organization_id,p_staff_id)
    )
  ) then raise exception 'attendance_correction_forbidden'; end if;
  perform 1 from public.timefit_user_staff where id=p_staff_id and organization_id=p_organization_id for update;
  if not found then raise exception 'staff_not_found'; end if;
  if p_work_date is null or p_work_date > (now() at time zone 'Asia/Seoul')::date
    or p_checked_in_at is null or (p_checked_in_at at time zone 'Asia/Seoul')::date <> p_work_date
    or p_checked_in_at > now() or p_checked_out_at > now()
    or (p_checked_out_at is not null and (p_checked_out_at <= p_checked_in_at or p_checked_out_at-p_checked_in_at > interval '48 hours'))
    or length(trim(coalesce(p_reason,''))) < 2 or length(p_reason) > 500
  then raise exception 'invalid_attendance_correction'; end if;
  select * into v_before from public.timefit_user_attendance_records
  where staff_id=p_staff_id and work_date=p_work_date for update;
  if v_before.updated_at is distinct from p_expected_updated_at then raise exception 'attendance_record_changed'; end if;
  if v_before.id is null then
    begin
      insert into public.timefit_user_attendance_records(organization_id,staff_id,work_date,checked_in_at,checked_out_at,source)
      values(p_organization_id,p_staff_id,p_work_date,p_checked_in_at,p_checked_out_at,'manager_correction') returning * into v_after;
    exception when unique_violation then raise exception 'attendance_record_changed';
    end;
  else
    update public.timefit_user_attendance_records
    set checked_in_at=p_checked_in_at, checked_out_at=p_checked_out_at, source='manager_correction'
    where id=v_before.id returning * into v_after;
  end if;
  insert into public.timefit_user_attendance_corrections(
    organization_id,staff_id,work_date,before_record,after_record,reason,corrected_by
  ) values(
    p_organization_id,p_staff_id,p_work_date,
    case when v_before.id is null then null else to_jsonb(v_before) end,
    to_jsonb(v_after),trim(p_reason),auth.uid()
  );
  return to_jsonb(v_after);
end $$;
