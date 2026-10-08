-- Mobile PWA read contracts for the role-aware home and schedule screens.

create or replace function public.timefit_user_mobile_can_access_organization(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and (
    exists (
      select 1
      from public.timefit_user_organizations organization
      where organization.id = p_organization_id
        and organization.owner_id = auth.uid()
    )
    or exists (
      select 1
      from public.timefit_user_memberships membership
      where membership.organization_id = p_organization_id
        and membership.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.timefit_user_management_accounts account
      where account.organization_id = p_organization_id
        and account.user_id = auth.uid()
        and account.status = 'active'
    )
  )
$$;

create or replace function public.timefit_user_mobile_home(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_role text;
  v_staff_id uuid;
  v_schedule jsonb;
  v_attendance jsonb;
  v_pending_requests integer := 0;
  v_scheduled_staff integer := 0;
  v_checked_in_staff integer := 0;
  v_missing_staff integer := 0;
  v_pending_approvals integer := 0;
begin
  if not public.timefit_user_mobile_can_access_organization(p_organization_id) then
    raise exception using errcode = '42501', message = 'organization_access_denied';
  end if;

  select case
    when organization.owner_id = auth.uid() then 'owner'
    when membership.role::text = 'manager' then 'manager'
    when membership.role::text = 'employee' then 'employee'
    when management.id is not null then 'manager'
    else null
  end
  into v_role
  from public.timefit_user_organizations organization
  left join public.timefit_user_memberships membership
    on membership.organization_id = organization.id
   and membership.user_id = auth.uid()
  left join public.timefit_user_management_accounts management
    on management.organization_id = organization.id
   and management.user_id = auth.uid()
   and management.status = 'active'
  where organization.id = p_organization_id;

  select staff.id
  into v_staff_id
  from public.timefit_user_staff staff
  where staff.organization_id = p_organization_id
    and staff.user_id = auth.uid()
  limit 1;

  if v_role = 'employee' then
    select jsonb_build_object(
      'id', schedule.id,
      'work_date', schedule.work_date,
      'starts_at', schedule.starts_at,
      'ends_at', schedule.ends_at,
      'shift_name', schedule.shift_name,
      'is_day_off', schedule.is_day_off,
      'approval_status', schedule.approval_status
    )
    into v_schedule
    from public.timefit_user_work_schedules schedule
    where schedule.organization_id = p_organization_id
      and schedule.staff_id = v_staff_id
      and schedule.work_date = v_today
      and schedule.status <> 'cancelled'
    limit 1;

    select jsonb_build_object(
      'id', attendance.id,
      'work_date', attendance.work_date,
      'checked_in_at', attendance.checked_in_at,
      'checked_out_at', attendance.checked_out_at,
      'source', attendance.source
    )
    into v_attendance
    from public.timefit_user_attendance_records attendance
    where attendance.organization_id = p_organization_id
      and attendance.staff_id = v_staff_id
      and attendance.work_date = v_today
    limit 1;

    select count(*)::integer
    into v_pending_requests
    from public.timefit_user_leave_requests request
    where request.organization_id = p_organization_id
      and request.staff_id = v_staff_id
      and request.status = 'pending';
  else
    select
      count(*) filter (where not schedule.is_day_off and schedule.approval_status = 'approved')::integer,
      count(attendance.id) filter (where attendance.checked_in_at is not null)::integer,
      count(*) filter (
        where not schedule.is_day_off
          and schedule.approval_status = 'approved'
          and schedule.starts_at <= (now() at time zone 'Asia/Seoul')::time
          and attendance.checked_in_at is null
      )::integer
    into v_scheduled_staff, v_checked_in_staff, v_missing_staff
    from public.timefit_user_work_schedules schedule
    join public.timefit_user_staff staff on staff.id = schedule.staff_id
    left join public.timefit_user_attendance_records attendance
      on attendance.organization_id = schedule.organization_id
     and attendance.staff_id = schedule.staff_id
     and attendance.work_date = schedule.work_date
    where schedule.organization_id = p_organization_id
      and schedule.work_date = v_today
      and schedule.status <> 'cancelled'
      and (
        v_role = 'owner'
        or public.timefit_user_has_membership_role(p_organization_id, array['manager']::public.timefit_user_role[])
        or (
          public.timefit_user_has_management_permission(p_organization_id, 'dashboard.view')
          and public.timefit_user_management_can_access_staff(p_organization_id, staff.id)
        )
      );

    select (
      (select count(*)
       from public.timefit_user_leave_requests request
       join public.timefit_user_staff staff on staff.id = request.staff_id
       where request.organization_id = p_organization_id
         and request.status = 'pending'
         and (
           v_role = 'owner'
           or public.timefit_user_has_membership_role(p_organization_id, array['manager']::public.timefit_user_role[])
           or (
             public.timefit_user_has_management_permission(p_organization_id, 'leave.review')
             and public.timefit_user_management_can_access_staff(p_organization_id, staff.id)
           )
         ))
      +
      (select count(*)
       from public.timefit_user_work_schedules schedule
       join public.timefit_user_staff staff on staff.id = schedule.staff_id
       where schedule.organization_id = p_organization_id
         and schedule.approval_status = 'pending'
         and (
           v_role = 'owner'
           or public.timefit_user_has_membership_role(p_organization_id, array['manager']::public.timefit_user_role[])
           or (
             public.timefit_user_has_management_permission(p_organization_id, 'schedule.manage')
             and public.timefit_user_management_can_access_staff(p_organization_id, staff.id)
           )
         ))
    )::integer
    into v_pending_approvals;
  end if;

  return jsonb_build_object(
    'data', jsonb_build_object(
      'role', v_role,
      'date', v_today,
      'employee', case when v_role = 'employee' then jsonb_build_object(
        'schedule', v_schedule,
        'attendance', v_attendance,
        'pending_requests', v_pending_requests
      ) else null end,
      'operations', case when v_role <> 'employee' then jsonb_build_object(
        'scheduled_staff', v_scheduled_staff,
        'checked_in_staff', v_checked_in_staff,
        'missing_staff', v_missing_staff,
        'pending_approvals', v_pending_approvals
      ) else null end
    ),
    'meta', jsonb_build_object(
      'contract_version', '1.0',
      'server_time', now(),
      'request_id', gen_random_uuid()
    )
  );
end
$$;

create or replace function public.timefit_user_mobile_schedule_range(
  p_organization_id uuid,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_staff_id uuid;
  v_items jsonb;
begin
  if not public.timefit_user_mobile_can_access_organization(p_organization_id) then
    raise exception using errcode = '42501', message = 'organization_access_denied';
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 62 then
    raise exception using errcode = '22023', message = 'invalid_schedule_range';
  end if;

  select case
    when organization.owner_id = auth.uid() then 'owner'
    when membership.role::text = 'manager' then 'manager'
    when membership.role::text = 'employee' then 'employee'
    when management.id is not null then 'manager'
    else null
  end
  into v_role
  from public.timefit_user_organizations organization
  left join public.timefit_user_memberships membership
    on membership.organization_id = organization.id
   and membership.user_id = auth.uid()
  left join public.timefit_user_management_accounts management
    on management.organization_id = organization.id
   and management.user_id = auth.uid()
   and management.status = 'active'
  where organization.id = p_organization_id;

  select staff.id
  into v_staff_id
  from public.timefit_user_staff staff
  where staff.organization_id = p_organization_id
    and staff.user_id = auth.uid()
  limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', schedule.id,
    'staff_id', schedule.staff_id,
    'staff_name', coalesce(account.display_name, staff.display_name, '직원'),
    'work_date', schedule.work_date,
    'starts_at', schedule.starts_at,
    'ends_at', schedule.ends_at,
    'break_minutes', schedule.break_minutes,
    'shift_name', coalesce(schedule.shift_name, case when schedule.is_day_off then '휴무' else '일반 근무' end),
    'is_day_off', schedule.is_day_off,
    'status', schedule.status,
    'approval_status', schedule.approval_status
  ) order by schedule.work_date, schedule.starts_at nulls last, staff.display_name), '[]'::jsonb)
  into v_items
  from public.timefit_user_work_schedules schedule
  join public.timefit_user_staff staff on staff.id = schedule.staff_id
  left join public.timefit_user_accounts account on account.id = staff.user_id
  where schedule.organization_id = p_organization_id
    and schedule.work_date between p_from and p_to
    and schedule.status <> 'cancelled'
    and (
      (v_role = 'employee' and schedule.staff_id = v_staff_id)
      or v_role = 'owner'
      or public.timefit_user_has_membership_role(p_organization_id, array['manager']::public.timefit_user_role[])
      or (
        public.timefit_user_has_management_permission(p_organization_id, 'schedule.view')
        and public.timefit_user_management_can_access_staff(p_organization_id, staff.id)
      )
    );

  return jsonb_build_object(
    'data', jsonb_build_object(
      'role', v_role,
      'from', p_from,
      'to', p_to,
      'items', v_items
    ),
    'meta', jsonb_build_object(
      'contract_version', '1.0',
      'server_time', now(),
      'request_id', gen_random_uuid()
    )
  );
end
$$;

revoke all on function public.timefit_user_mobile_can_access_organization(uuid) from public;
revoke all on function public.timefit_user_mobile_home(uuid) from public;
revoke all on function public.timefit_user_mobile_schedule_range(uuid, date, date) from public;

grant execute on function public.timefit_user_mobile_can_access_organization(uuid) to authenticated;
grant execute on function public.timefit_user_mobile_home(uuid) to authenticated;
grant execute on function public.timefit_user_mobile_schedule_range(uuid, date, date) to authenticated;

select pg_notify('pgrst', 'reload schema');
