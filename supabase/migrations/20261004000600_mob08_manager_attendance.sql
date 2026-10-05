-- MOB-08: scoped, date-based attendance dashboard for organization managers.
create or replace function public.timefit_user_mobile_manager_attendance(
  p_organization_id uuid,
  p_work_date date
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_timezone text;
  v_today date;
  v_now_time time;
  v_rows jsonb;
  v_counts jsonb;
begin
  if auth.uid() is null then
    raise exception using errcode='42501', message='authentication_required';
  end if;
  if p_organization_id is null or p_work_date is null then
    raise exception using errcode='22023', message='organization_and_work_date_required';
  end if;
  if not public.timefit_user_is_organization_owner(p_organization_id)
     and not public.timefit_user_has_management_permission(p_organization_id, 'attendance.view') then
    raise exception using errcode='42501', message='attendance_view_denied';
  end if;

  select coalesce(settings.timezone, 'Asia/Seoul')
    into v_timezone
  from public.timefit_user_organizations organization
  left join public.timefit_user_organization_settings settings
    on settings.organization_id=organization.id
  where organization.id=p_organization_id;
  if v_timezone is null then
    raise exception using errcode='P0002', message='organization_not_found';
  end if;
  v_today := (now() at time zone v_timezone)::date;
  v_now_time := (now() at time zone v_timezone)::time;

  with visible_attendance as (
    select
      staff.id as staff_id,
      coalesce(account.display_name, staff.display_name, '직원') as staff_name,
      category.name as category_name,
      staff.job_title,
      schedule.starts_at as scheduled_start,
      schedule.ends_at as scheduled_end,
      attendance.checked_in_at,
      attendance.checked_out_at,
      attendance.source,
      case
        when attendance.checked_out_at is not null then 'completed'
        when attendance.checked_in_at is not null then 'working'
        when p_work_date < v_today then 'missing'
        when p_work_date = v_today and schedule.starts_at is not null and v_now_time > schedule.starts_at then 'missing'
        else 'scheduled'
      end as attendance_status,
      attendance.checked_in_at is not null
        and schedule.starts_at is not null
        and (attendance.checked_in_at at time zone v_timezone)::time > schedule.starts_at as is_late
    from public.timefit_user_staff staff
    left join public.timefit_user_accounts account on account.id=staff.user_id
    left join public.timefit_user_staff_categories category on category.id=staff.category_id
    left join public.timefit_user_work_schedules schedule
      on schedule.staff_id=staff.id and schedule.work_date=p_work_date
      and schedule.status='published' and schedule.approval_status='approved' and not schedule.is_day_off
    left join public.timefit_user_attendance_records attendance
      on attendance.staff_id=staff.id and attendance.work_date=p_work_date
    where staff.organization_id=p_organization_id
      and (schedule.id is not null or attendance.id is not null)
      and (public.timefit_user_is_organization_owner(p_organization_id)
        or public.timefit_user_management_can_access_staff(p_organization_id, staff.id))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', staff_id,
    'staff_id', staff_id,
    'staff_name', staff_name,
    'category_name', category_name,
    'job_title', job_title,
    'work_date', p_work_date,
    'scheduled_start', scheduled_start,
    'scheduled_end', scheduled_end,
    'checked_in_at', checked_in_at,
    'checked_out_at', checked_out_at,
    'source', source,
    'status', attendance_status,
    'late', is_late
  ) order by scheduled_start nulls last, staff_name), '[]'::jsonb)
  into v_rows
  from visible_attendance;

  with visible_statuses as (
    select case
      when attendance.checked_out_at is not null then 'completed'
      when attendance.checked_in_at is not null then 'working'
      when p_work_date < v_today then 'missing'
      when p_work_date = v_today and schedule.starts_at is not null and v_now_time > schedule.starts_at then 'missing'
      else 'scheduled'
    end as attendance_status
    from public.timefit_user_staff staff
    left join public.timefit_user_work_schedules schedule
      on schedule.staff_id=staff.id and schedule.work_date=p_work_date
      and schedule.status='published' and schedule.approval_status='approved' and not schedule.is_day_off
    left join public.timefit_user_attendance_records attendance
      on attendance.staff_id=staff.id and attendance.work_date=p_work_date
    where staff.organization_id=p_organization_id
      and (schedule.id is not null or attendance.id is not null)
      and (public.timefit_user_is_organization_owner(p_organization_id)
        or public.timefit_user_management_can_access_staff(p_organization_id, staff.id))
  )
  select jsonb_build_object(
    'working', count(*) filter (where attendance_status='working'),
    'completed', count(*) filter (where attendance_status='completed'),
    'missing', count(*) filter (where attendance_status='missing'),
    'scheduled', count(*) filter (where attendance_status='scheduled')
  ) into v_counts
  from visible_statuses;

  return jsonb_build_object(
    'data', jsonb_build_object(
      'timezone', v_timezone,
      'workDate', p_work_date,
      'counts', v_counts,
      'rows', v_rows
    ),
    'meta', jsonb_build_object(
      'contract_version', '1.0',
      'server_time', now(),
      'request_id', gen_random_uuid()
    )
  );
end $$;

revoke all on function public.timefit_user_mobile_manager_attendance(uuid,date) from public;
grant execute on function public.timefit_user_mobile_manager_attendance(uuid,date) to authenticated;

