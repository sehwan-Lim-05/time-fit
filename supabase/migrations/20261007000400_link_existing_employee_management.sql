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
    'dashboard.view','attendance.view','attendance.manage','schedule.view','schedule.manage','leave.view','leave.review',
    'payroll.view','employee.view','employee.manage','sales.view','sales.sync','settings.manage','finance.view','expense.manage',
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
