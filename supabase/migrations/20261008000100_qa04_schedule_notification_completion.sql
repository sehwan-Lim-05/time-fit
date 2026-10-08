-- QA-04: complete employee schedule push messages without rewriting an applied migration.

alter table public.timefit_user_schedule_notification_outbox
  drop constraint if exists timefit_user_schedule_notification_outbox_event_type_check;
alter table public.timefit_user_schedule_notification_outbox
  add constraint timefit_user_schedule_notification_outbox_event_type_check
  check(event_type in ('schedule_approved','schedule_changed','schedule_cancelled'));

create or replace function public.timefit_user_enqueue_schedule_notification()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_recipient uuid;v_event text;v_dedupe text;
begin
  if tg_op='UPDATE' and new.status='cancelled' and old.status<>'cancelled' and old.approval_status='approved' then
    v_event:='schedule_cancelled';
  elsif new.approval_status<>'approved' or new.status='cancelled' then
    return new;
  elsif tg_op='UPDATE' and old.approval_status='approved'
    and (old.work_date,old.starts_at,old.ends_at,old.break_minutes,old.shift_name,old.is_day_off)
      is not distinct from (new.work_date,new.starts_at,new.ends_at,new.break_minutes,new.shift_name,new.is_day_off)
  then
    return new;
  else
    v_event:=case when tg_op='INSERT' or (tg_op='UPDATE' and old.approval_status<>'approved') then 'schedule_approved' else 'schedule_changed' end;
  end if;
  select user_id into v_recipient from public.timefit_user_staff where id=new.staff_id;
  if v_recipient is null then return new;end if;
  v_dedupe:=concat_ws(':','schedule',new.id,v_event,new.work_date,new.starts_at,new.ends_at,new.break_minutes,new.shift_name,new.is_day_off,new.status);
  insert into public.timefit_user_schedule_notification_outbox(organization_id,schedule_id,staff_id,recipient_user_id,event_type,payload,dedupe_key)
  values(new.organization_id,new.id,new.staff_id,v_recipient,v_event,jsonb_build_object('workDate',new.work_date,'startsAt',new.starts_at,'endsAt',new.ends_at,'breakMinutes',new.break_minutes,'shiftName',new.shift_name,'isDayOff',new.is_day_off),v_dedupe)
  on conflict(dedupe_key) do nothing;
  return new;
end $$;

create or replace function public.timefit_user_project_schedule_notification()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_organization_name text;v_title text;v_body text;v_path text;
begin
  select name into v_organization_name from public.timefit_user_organizations where id=new.organization_id;
  v_title:=case new.event_type
    when 'schedule_changed' then '근무 일정이 변경됐어요'
    when 'schedule_cancelled' then '근무 일정이 취소됐어요'
    else '근무 일정이 확정됐어요' end;
  v_body:=concat(
    coalesce(v_organization_name,'업장'),' · ',coalesce(new.payload->>'workDate','예정된 날짜'),' · ',
    case
      when new.event_type='schedule_cancelled' then '일정 취소'
      when coalesce((new.payload->>'isDayOff')::boolean,false) then '휴무'
      else concat(left(coalesce(new.payload->>'startsAt','--:--'),5),'~',left(coalesce(new.payload->>'endsAt','--:--'),5))
    end
  );
  v_path:=concat('/#schedule?date=',coalesce(new.payload->>'workDate',''),'&id=',new.schedule_id);
  insert into public.timefit_user_notifications(organization_id,recipient_user_id,notification_type,title,body,deeplink_path,dedupe_key,metadata)
  values(new.organization_id,new.recipient_user_id,new.event_type,v_title,v_body,v_path,new.dedupe_key,
    new.payload||jsonb_build_object('scheduleId',new.schedule_id,'outboxId',new.id))
  on conflict(recipient_user_id,dedupe_key) do nothing;
  return new;
end $$;

select pg_notify('pgrst','reload schema');
