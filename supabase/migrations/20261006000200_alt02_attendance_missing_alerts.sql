-- ALT-02: schedule-aware missing check-in/check-out detection.
-- Operational alerts are immutable incidents. User notifications are durable
-- projections handled by ALT-01 and push remains an optional delivery channel.

alter table public.timefit_user_organization_settings
  add column if not exists checkout_alert_delay_minutes integer not null default 30
    check (checkout_alert_delay_minutes between 0 and 180),
  add column if not exists attendance_alert_policy_version integer not null default 1
    check (attendance_alert_policy_version > 0);

-- Allow a shift end earlier than its start to mean that the shift ends on the
-- following local calendar day. Equal start/end remains invalid.
do $$
declare constraint_name text;
begin
  for constraint_name in
    select conname from pg_constraint
    where conrelid='public.timefit_user_work_schedules'::regclass and contype='c'
      and pg_get_constraintdef(oid) like '%starts_at%ends_at%'
      and pg_get_constraintdef(oid) not like '%break_%'
  loop execute format('alter table public.timefit_user_work_schedules drop constraint %I',constraint_name);end loop;
end $$;
alter table public.timefit_user_work_schedules
  add constraint timefit_user_work_schedules_shift_window_check check (
    (is_day_off and starts_at is null and ends_at is null)
    or (not is_day_off and starts_at is not null and ends_at is not null and starts_at<>ends_at)
  );

do $$
declare constraint_name text;
begin
  for constraint_name in
    select conname from pg_constraint
    where conrelid='public.timefit_user_operational_alerts'::regclass and contype='c'
      and (pg_get_constraintdef(oid) like '%alert_type%' or pg_get_constraintdef(oid) like '%status%')
  loop execute format('alter table public.timefit_user_operational_alerts drop constraint %I',constraint_name);end loop;
end $$;

alter table public.timefit_user_operational_alerts
  add column if not exists policy_version integer not null default 1,
  add column if not exists last_observed_at timestamptz,
  add column if not exists resolved_at timestamptz,
  add column if not exists resolution_reason text,
  add constraint timefit_operational_alert_type_check
    check (alert_type in ('absence_after_scheduled_start','checkout_after_scheduled_end')),
  add constraint timefit_operational_alert_status_check
    check (status in ('queued','sent','read','failed','resolved','cancelled'));

alter table public.timefit_user_operational_alerts
  drop constraint if exists timefit_user_operational_alerts_schedule_id_alert_type_key;
create unique index if not exists timefit_operational_alert_incident_unique
  on public.timefit_user_operational_alerts(schedule_id,alert_type,policy_version);

create or replace function public.timefit_user_fanout_attendance_alert(p_alert_id uuid)
returns integer language plpgsql security definer set search_path=public as $$
declare v_alert record;v_recipient record;v_count integer:=0;v_type text;v_title text;v_path text;v_dedupe text;
begin
  select alert.*,schedule.work_date,staff.category_id into v_alert
  from public.timefit_user_operational_alerts alert
  join public.timefit_user_work_schedules schedule on schedule.id=alert.schedule_id
  join public.timefit_user_staff staff on staff.id=alert.staff_id
  where alert.id=p_alert_id and alert.status in ('queued','sent','read','failed');
  if v_alert.id is null then return 0;end if;
  v_type:=case when v_alert.alert_type='checkout_after_scheduled_end' then 'attendance_missing_checkout' else 'attendance_missing_checkin' end;
  v_title:=case when v_alert.alert_type='checkout_after_scheduled_end' then '퇴근 기록을 확인해 주세요' else '출근 기록을 확인해 주세요' end;
  v_path:='/#attendance?date='||v_alert.work_date::text||'&staff='||v_alert.staff_id::text||'&alert='||v_alert.alert_type;
  v_dedupe:='attendance:'||v_alert.schedule_id::text||':'||v_alert.alert_type||':v'||v_alert.policy_version::text;

  for v_recipient in
    select organization.owner_id user_id from public.timefit_user_organizations organization
      where organization.id=v_alert.organization_id and organization.owner_id is not null
    union
    select account.user_id from public.timefit_user_management_accounts account
      join public.timefit_user_management_permissions permission on permission.management_account_id=account.id
        and permission.permission_code='attendance.view' and permission.allowed
      where account.organization_id=v_alert.organization_id and account.status='active'
        and (not exists(select 1 from public.timefit_user_management_scopes scope where scope.management_account_id=account.id)
          or exists(select 1 from public.timefit_user_management_scopes scope where scope.management_account_id=account.id and scope.category_id=v_alert.category_id))
  loop
    insert into public.timefit_user_notifications(
      organization_id,recipient_user_id,notification_type,title,body,deeplink_path,dedupe_key,metadata
    ) values (
      v_alert.organization_id,v_recipient.user_id,v_type,v_title,v_alert.message,v_path,v_dedupe,
      jsonb_build_object('operationalAlertId',v_alert.id,'scheduleId',v_alert.schedule_id,'staffId',v_alert.staff_id,
        'workDate',v_alert.work_date,'alertType',v_alert.alert_type,'scheduledFor',v_alert.scheduled_for)
    ) on conflict(recipient_user_id,dedupe_key) do nothing;
    if found then v_count:=v_count+1;end if;
  end loop;
  return v_count;
end $$;

create or replace function public.timefit_user_scan_absence_alerts(
  p_organization_id uuid,
  p_work_date date default (now() at time zone 'Asia/Seoul')::date
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_settings public.timefit_user_organization_settings;
  v_row record;v_leave record;v_alert_id uuid;v_now timestamptz:=clock_timestamp();
  v_start timestamptz;v_end timestamptz;v_effective_start time;v_effective_end time;
  v_created integer:=0;v_notifications integer:=0;v_resolved integer:=0;v_affected integer:=0;
  v_inserted boolean:=false;v_timezone text;
begin
  if auth.role()<>'service_role' and not public.timefit_user_has_membership_role(p_organization_id,array['manager']::public.timefit_user_role[]) then
    raise exception using errcode='42501',message='manager_role_required';
  end if;
  select * into v_settings from public.timefit_user_organization_settings where organization_id=p_organization_id;
  if v_settings is null or not v_settings.absence_alert_enabled then
    return jsonb_build_object('created',0,'notifications',0,'resolved',0);
  end if;
  v_timezone:=coalesce(v_settings.timezone,'Asia/Seoul');

  update public.timefit_user_operational_alerts alert set status='cancelled',resolved_at=v_now,
    resolution_reason='schedule_no_longer_eligible',last_observed_at=v_now
  from public.timefit_user_work_schedules schedule
  where alert.schedule_id=schedule.id and alert.organization_id=p_organization_id
    and alert.status not in ('resolved','cancelled')
    and (schedule.status<>'published' or schedule.approval_status<>'approved' or schedule.is_day_off);
  get diagnostics v_resolved=row_count;

  for v_row in
    select schedule.id schedule_id,schedule.staff_id,schedule.work_date,schedule.starts_at,schedule.ends_at,
      coalesce(account.display_name,staff.display_name,'직원') staff_name,
      attendance.checked_in_at,attendance.checked_out_at
    from public.timefit_user_work_schedules schedule
    join public.timefit_user_staff staff on staff.id=schedule.staff_id
    left join public.timefit_user_accounts account on account.id=staff.user_id
    left join public.timefit_user_attendance_records attendance
      on attendance.staff_id=schedule.staff_id and attendance.work_date=schedule.work_date
    where schedule.organization_id=p_organization_id
      and schedule.work_date between p_work_date-1 and p_work_date
      and schedule.status='published' and schedule.approval_status='approved'
      and not schedule.is_day_off and schedule.starts_at is not null and schedule.ends_at is not null
  loop
    select request.day_part,request.amount into v_leave
    from public.timefit_user_leave_requests request
    where request.staff_id=v_row.staff_id and request.status='approved'
      and v_row.work_date between request.starts_on and request.ends_on
    order by case coalesce(request.day_part,'full') when 'full' then 0 else 1 end,request.updated_at desc limit 1;

    if coalesce(v_leave.day_part,case when coalesce(v_leave.amount,0)>=1 then 'full' end)='full' then
      update public.timefit_user_operational_alerts set status='cancelled',resolved_at=v_now,
        resolution_reason='approved_full_day_leave',last_observed_at=v_now
      where schedule_id=v_row.schedule_id and status not in ('resolved','cancelled');
      get diagnostics v_affected=row_count;v_resolved:=v_resolved+v_affected;
      continue;
    end if;

    v_effective_start:=case when v_leave.day_part='am' then greatest(v_row.starts_at,time '13:00') else v_row.starts_at end;
    v_effective_end:=case when v_leave.day_part='pm' then least(v_row.ends_at,time '13:00') else v_row.ends_at end;
    if v_effective_start=v_effective_end
      or (v_row.ends_at>v_row.starts_at and v_effective_end<v_effective_start) then continue;end if;
    v_start:=(v_row.work_date+v_effective_start) at time zone v_timezone;
    v_end:=(v_row.work_date+case when v_effective_end<=v_effective_start then 1 else 0 end+v_effective_end) at time zone v_timezone;

    if v_row.checked_in_at is not null then
      update public.timefit_user_operational_alerts set status='resolved',resolved_at=coalesce(resolved_at,v_now),
        resolution_reason='check_in_recorded',last_observed_at=v_now
      where schedule_id=v_row.schedule_id and alert_type='absence_after_scheduled_start' and status not in ('resolved','cancelled');
      get diagnostics v_affected=row_count;v_resolved:=v_resolved+v_affected;
    elsif v_now>=v_start+make_interval(mins=>v_settings.absence_alert_delay_minutes) then
      insert into public.timefit_user_operational_alerts(
        organization_id,staff_id,schedule_id,alert_type,scheduled_for,message,policy_version,last_observed_at
      ) values (
        p_organization_id,v_row.staff_id,v_row.schedule_id,'absence_after_scheduled_start',
        v_start+make_interval(mins=>v_settings.absence_alert_delay_minutes),
        v_row.staff_name||'님이 '||to_char(v_effective_start,'HH24:MI')||' 출근 예정이지만 출근 기록이 없습니다.',
        v_settings.attendance_alert_policy_version,v_now
      ) on conflict(schedule_id,alert_type,policy_version) do update set last_observed_at=excluded.last_observed_at
        returning id,(xmax=0) into v_alert_id,v_inserted;
      if v_inserted then v_created:=v_created+1;end if;
      v_notifications:=v_notifications+public.timefit_user_fanout_attendance_alert(v_alert_id);
    end if;

    if v_row.checked_out_at is not null then
      update public.timefit_user_operational_alerts set status='resolved',resolved_at=coalesce(resolved_at,v_now),
        resolution_reason='check_out_recorded',last_observed_at=v_now
      where schedule_id=v_row.schedule_id and alert_type='checkout_after_scheduled_end' and status not in ('resolved','cancelled');
      get diagnostics v_affected=row_count;v_resolved:=v_resolved+v_affected;
    elsif v_row.checked_in_at is not null and v_now>=v_end+make_interval(mins=>v_settings.checkout_alert_delay_minutes) then
      insert into public.timefit_user_operational_alerts(
        organization_id,staff_id,schedule_id,alert_type,scheduled_for,message,policy_version,last_observed_at
      ) values (
        p_organization_id,v_row.staff_id,v_row.schedule_id,'checkout_after_scheduled_end',
        v_end+make_interval(mins=>v_settings.checkout_alert_delay_minutes),
        v_row.staff_name||'님의 '||to_char(v_effective_end,'HH24:MI')||' 예정 근무에 퇴근 기록이 없습니다.',
        v_settings.attendance_alert_policy_version,v_now
      ) on conflict(schedule_id,alert_type,policy_version) do update set last_observed_at=excluded.last_observed_at
        returning id,(xmax=0) into v_alert_id,v_inserted;
      if v_inserted then v_created:=v_created+1;end if;
      v_notifications:=v_notifications+public.timefit_user_fanout_attendance_alert(v_alert_id);
    end if;
  end loop;
  return jsonb_build_object('created',v_created,'notifications',v_notifications,'resolved',v_resolved,'observedAt',v_now);
end $$;

revoke all on function public.timefit_user_fanout_attendance_alert(uuid) from public;
grant execute on function public.timefit_user_fanout_attendance_alert(uuid) to service_role;
revoke all on function public.timefit_user_scan_absence_alerts(uuid,date) from public;
grant execute on function public.timefit_user_scan_absence_alerts(uuid,date) to authenticated,service_role;
select pg_notify('pgrst','reload schema');
