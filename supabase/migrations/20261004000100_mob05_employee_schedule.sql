-- MOB-05: employee-only, published schedule range with approved leave.
create or replace function public.timefit_user_mobile_schedule_range(
  p_organization_id uuid,
  p_from date,
  p_to date
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_timezone text;
  v_items jsonb;
  v_leaves jsonb;
begin
  if not public.timefit_user_mobile_can_access_organization(p_organization_id) then
    raise exception using errcode = '42501', message = 'organization_access_denied';
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 62 then
    raise exception using errcode = '22023', message = 'invalid_schedule_range';
  end if;

  select staff.id into v_staff_id
  from public.timefit_user_staff staff
  where staff.organization_id = p_organization_id and staff.user_id = auth.uid()
  limit 1;
  if v_staff_id is null then
    raise exception using errcode = '42501', message = 'staff_not_linked';
  end if;

  select coalesce(settings.timezone, 'Asia/Seoul') into v_timezone
  from public.timefit_user_organizations organization
  left join public.timefit_user_organization_settings settings on settings.organization_id = organization.id
  where organization.id = p_organization_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', schedule.id, 'work_date', schedule.work_date,
    'starts_at', schedule.starts_at, 'ends_at', schedule.ends_at,
    'break_minutes', schedule.break_minutes,
    'shift_name', coalesce(schedule.shift_name, case when schedule.is_day_off then '휴무' else '일반 근무' end),
    'is_day_off', schedule.is_day_off, 'updated_at', schedule.updated_at
  ) order by schedule.work_date, schedule.starts_at nulls last), '[]'::jsonb)
  into v_items
  from public.timefit_user_work_schedules schedule
  where schedule.organization_id = p_organization_id
    and schedule.staff_id = v_staff_id
    and schedule.work_date between p_from and p_to
    and schedule.status = 'published'
    and schedule.approval_status = 'approved';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', request.id, 'starts_on', request.starts_on, 'ends_on', request.ends_on,
    'leave_type', request.leave_type, 'amount', request.amount
  ) order by request.starts_on), '[]'::jsonb)
  into v_leaves
  from public.timefit_user_leave_requests request
  where request.organization_id = p_organization_id
    and request.staff_id = v_staff_id
    and request.status = 'approved'
    and request.starts_on <= p_to and request.ends_on >= p_from;

  return jsonb_build_object(
    'data', jsonb_build_object('from', p_from, 'to', p_to, 'timezone', v_timezone, 'items', v_items, 'leaves', v_leaves),
    'meta', jsonb_build_object('contract_version', '2.0', 'server_time', now(), 'request_id', gen_random_uuid())
  );
end $$;

revoke all on function public.timefit_user_mobile_schedule_range(uuid, date, date) from public;
grant execute on function public.timefit_user_mobile_schedule_range(uuid, date, date) to authenticated;
select pg_notify('pgrst', 'reload schema');
