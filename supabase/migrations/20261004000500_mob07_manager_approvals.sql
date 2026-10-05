-- MOB-07: secure manager approval inbox for leave and schedule requests.
do $$
declare v_constraint text;
begin
  select conname into v_constraint from pg_constraint
  where conrelid='public.timefit_user_management_permissions'::regclass and contype='c' and pg_get_constraintdef(oid) like '%permission_code%';
  if v_constraint is not null then execute format('alter table public.timefit_user_management_permissions drop constraint %I',v_constraint); end if;
end $$;

alter table public.timefit_user_management_permissions
  add constraint timefit_user_management_permissions_code_check
  check(permission_code in (
    'dashboard.view','attendance.view','attendance.review_correction','schedule.view','schedule.manage','schedule.approve',
    'leave.view','leave.review','employee.view','employee.manage','payroll.view','finance.view','expense.manage',
    'expense.receipt.review','expense.card.manage','expense.closeout.manage','expense.export','sales.view','sales.sync','settings.manage'
  ));

create table if not exists public.timefit_user_mobile_approval_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  request_key uuid not null,
  item_kind text not null check(item_kind in ('leave','schedule')),
  item_id uuid not null,
  decision text not null check(decision in ('approved','rejected')),
  result jsonb not null,
  created_at timestamptz not null default now(),
  unique(actor_id,request_key)
);

alter table public.timefit_user_mobile_approval_actions enable row level security;
drop policy if exists "mobile approval actors read own actions" on public.timefit_user_mobile_approval_actions;
create policy "mobile approval actors read own actions" on public.timefit_user_mobile_approval_actions
  for select using(actor_id=auth.uid());

create or replace function public.timefit_user_mobile_can_review_staff(p_organization_id uuid,p_staff_id uuid,p_permission text)
returns boolean language sql stable security definer set search_path=public as $$
  select auth.uid() is not null and (
    public.timefit_user_is_organization_owner(p_organization_id)
    or (public.timefit_user_has_management_permission(p_organization_id,p_permission)
      and public.timefit_user_management_can_access_staff(p_organization_id,p_staff_id))
  );
$$;

create or replace function public.timefit_user_mobile_approval_inbox(p_organization_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_timezone text; v_items jsonb; v_pending int; v_approved int; v_rejected int;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='authentication_required'; end if;
  if not public.timefit_user_is_organization_owner(p_organization_id)
    and not public.timefit_user_has_management_permission(p_organization_id,'leave.review')
    and not public.timefit_user_has_management_permission(p_organization_id,'schedule.approve') then
    raise exception using errcode='42501',message='approval_access_denied';
  end if;
  select coalesce(settings.timezone,'Asia/Seoul') into v_timezone
  from public.timefit_user_organizations organization left join public.timefit_user_organization_settings settings on settings.organization_id=organization.id
  where organization.id=p_organization_id;
  if v_timezone is null then raise exception using errcode='42501',message='approval_access_denied'; end if;

  with accessible as (
    select request.id,'leave'::text kind,request.status::text status,request.staff_id,staff.display_name staff_name,category.name category_name,
      request.starts_on,request.ends_on,request.leave_type title,
      concat(request.amount,'일 · ',case request.day_part when 'am' then '오전 반차' when 'pm' then '오후 반차' else '종일' end) detail,
      request.reason,request.review_comment,request.created_at submitted_at,request.reviewed_at
    from public.timefit_user_leave_requests request
    join public.timefit_user_staff staff on staff.id=request.staff_id
    left join public.timefit_user_staff_categories category on category.id=staff.category_id
    where request.organization_id=p_organization_id
      and public.timefit_user_mobile_can_review_staff(p_organization_id,request.staff_id,'leave.review')
    union all
    select schedule.id,'schedule',schedule.approval_status,schedule.staff_id,staff.display_name,category.name,
      schedule.work_date,schedule.work_date,coalesce(nullif(schedule.shift_name,''),'근무 일정'),
      case when schedule.is_day_off then '휴무' else concat(to_char(schedule.starts_at,'HH24:MI'),' ~ ',to_char(schedule.ends_at,'HH24:MI')) end,
      null::text,schedule.review_comment,coalesce(schedule.submitted_at,schedule.created_at),schedule.reviewed_at
    from public.timefit_user_work_schedules schedule
    join public.timefit_user_staff staff on staff.id=schedule.staff_id
    left join public.timefit_user_staff_categories category on category.id=staff.category_id
    where schedule.organization_id=p_organization_id
      and public.timefit_user_mobile_can_review_staff(p_organization_id,schedule.staff_id,'schedule.approve')
  ), limited as (select * from accessible order by submitted_at desc limit 200)
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',id,'kind',kind,'status',status,'staff_id',staff_id,'staff_name',staff_name,'category_name',category_name,
    'starts_on',starts_on,'ends_on',ends_on,'title',title,'detail',detail,'reason',reason,'review_comment',review_comment,
    'submitted_at',submitted_at,'reviewed_at',reviewed_at
  ) order by submitted_at desc),'[]'::jsonb),
  count(*) filter(where status='pending'),count(*) filter(where status='approved'),count(*) filter(where status='rejected')
  into v_items,v_pending,v_approved,v_rejected from limited;

  return jsonb_build_object('data',jsonb_build_object('timezone',v_timezone,'counts',jsonb_build_object(
    'pending',v_pending,'approved',v_approved,'rejected',v_rejected),'items',v_items),
    'meta',jsonb_build_object('contract_version','1.0','server_time',now(),'request_id',gen_random_uuid()));
end $$;

create or replace function public.timefit_user_mobile_review_approval(
  p_organization_id uuid,p_kind text,p_request_id uuid,p_decision text,p_comment text,p_request_key uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_existing jsonb; v_staff_id uuid; v_status text; v_result jsonb;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='authentication_required'; end if;
  if p_kind not in ('leave','schedule') or p_decision not in ('approved','rejected') or p_request_key is null then
    raise exception using errcode='22023',message='invalid_approval_request';
  end if;
  if length(coalesce(p_comment,''))>500 or (p_decision='rejected' and length(trim(coalesce(p_comment,'')))<2) then
    raise exception using errcode='22023',message='invalid_review_comment';
  end if;
  select result into v_existing from public.timefit_user_mobile_approval_actions where actor_id=auth.uid() and request_key=p_request_key;
  if v_existing is not null then return v_existing||jsonb_build_object('duplicate',true); end if;

  if p_kind='leave' then
    select staff_id,status::text into v_staff_id,v_status from public.timefit_user_leave_requests
      where id=p_request_id and organization_id=p_organization_id for update;
    if v_staff_id is null or not public.timefit_user_mobile_can_review_staff(p_organization_id,v_staff_id,'leave.review') then
      raise exception using errcode='42501',message='approval_access_denied';
    end if;
    if v_status<>'pending' then raise exception using errcode='40001',message='approval_already_processed'; end if;
    update public.timefit_user_leave_requests set status=p_decision::public.timefit_user_leave_status,
      review_comment=nullif(trim(p_comment),''),reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now()
      where id=p_request_id returning jsonb_build_object('id',id,'kind','leave','status',status,'review_comment',review_comment,'reviewed_at',reviewed_at) into v_result;
  else
    select staff_id,approval_status into v_staff_id,v_status from public.timefit_user_work_schedules
      where id=p_request_id and organization_id=p_organization_id for update;
    if v_staff_id is null or not public.timefit_user_mobile_can_review_staff(p_organization_id,v_staff_id,'schedule.approve') then
      raise exception using errcode='42501',message='approval_access_denied';
    end if;
    if v_status<>'pending' then raise exception using errcode='40001',message='approval_already_processed'; end if;
    update public.timefit_user_work_schedules set approval_status=p_decision,review_comment=nullif(trim(p_comment),''),
      reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now() where id=p_request_id
      returning jsonb_build_object('id',id,'kind','schedule','status',approval_status,'review_comment',review_comment,'reviewed_at',reviewed_at) into v_result;
  end if;
  v_result:=v_result||jsonb_build_object('duplicate',false);
  insert into public.timefit_user_mobile_approval_actions(organization_id,actor_id,request_key,item_kind,item_id,decision,result)
    values(p_organization_id,auth.uid(),p_request_key,p_kind,p_request_id,p_decision,v_result);
  return v_result;
end $$;

revoke all on function public.timefit_user_mobile_can_review_staff(uuid,uuid,text) from public;
revoke all on function public.timefit_user_mobile_approval_inbox(uuid) from public;
revoke all on function public.timefit_user_mobile_review_approval(uuid,text,uuid,text,text,uuid) from public;
grant execute on function public.timefit_user_mobile_approval_inbox(uuid) to authenticated;
grant execute on function public.timefit_user_mobile_review_approval(uuid,text,uuid,text,text,uuid) to authenticated;
grant select on public.timefit_user_mobile_approval_actions to authenticated;
grant all on public.timefit_user_mobile_approval_actions to service_role;
select pg_notify('pgrst','reload schema');
