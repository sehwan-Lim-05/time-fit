-- MOB-09: make mobile attendance and leave cancellation safe to retry after
-- ambiguous network failures. Request keys are scoped to the authenticated
-- staff member and the server always returns the originally persisted state.

alter table public.timefit_user_attendance_records
  add column if not exists check_in_request_key uuid,
  add column if not exists check_out_request_key uuid;

create unique index if not exists timefit_mobile_attendance_check_in_request_unique
  on public.timefit_user_attendance_records(staff_id,check_in_request_key)
  where check_in_request_key is not null;
create unique index if not exists timefit_mobile_attendance_check_out_request_unique
  on public.timefit_user_attendance_records(staff_id,check_out_request_key)
  where check_out_request_key is not null;

alter table public.timefit_user_leave_requests
  add column if not exists mobile_cancel_request_key uuid;
create unique index if not exists timefit_leave_mobile_cancel_request_unique
  on public.timefit_user_leave_requests(staff_id,mobile_cancel_request_key)
  where mobile_cancel_request_key is not null;

create or replace function public.timefit_user_mobile_qr_attendance(
  p_token text,
  p_action text,
  p_request_key uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_staff public.timefit_user_staff;
  v_qr public.timefit_user_mobile_attendance_qr_tokens;
  v_record public.timefit_user_attendance_records;
  v_timezone text;
  v_today date;
  v_now timestamptz:=now();
  v_duplicate boolean:=false;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='authentication_required';end if;
  if p_action not in ('check_in','check_out') or p_request_key is null then raise exception using errcode='22023',message='invalid_attendance_request';end if;
  select * into v_staff from public.timefit_user_staff where user_id=auth.uid() limit 1;
  if v_staff.id is null then raise exception using errcode='P0002',message='staff_not_found';end if;
  select coalesce(timezone,'Asia/Seoul') into v_timezone from public.timefit_user_organization_settings where organization_id=v_staff.organization_id;
  v_timezone:=coalesce(v_timezone,'Asia/Seoul');v_today:=(v_now at time zone v_timezone)::date;

  select * into v_record from public.timefit_user_attendance_records
    where staff_id=v_staff.id and work_date=v_today for update;
  if (p_action='check_in' and v_record.check_in_request_key=p_request_key)
     or (p_action='check_out' and v_record.check_out_request_key=p_request_key) then
    v_duplicate:=true;
    return jsonb_build_object('workDate',v_today,'timezone',v_timezone,'checkedInAt',v_record.checked_in_at,'checkedOutAt',v_record.checked_out_at,'nextAction',case when v_record.checked_in_at is null then 'check_in' when v_record.checked_out_at is null then 'check_out' else 'completed' end,'duplicate',v_duplicate,'serverTime',v_now,'requestId',p_request_key);
  end if;

  select * into v_qr from public.timefit_user_mobile_attendance_qr_tokens
    where organization_id=v_staff.organization_id and token_hash=encode(extensions.digest(trim(p_token),'sha256'),'hex')
      and is_active and work_date=v_today and expires_at>v_now limit 1;
  if v_qr.id is null then raise exception using errcode='22023',message='invalid_or_expired_qr';end if;

  if p_action='check_in' then
    if v_record.checked_in_at is not null then raise exception using errcode='23505',message='already_checked_in';end if;
    insert into public.timefit_user_attendance_records(organization_id,staff_id,work_date,checked_in_at,source,check_in_request_key)
      values(v_staff.organization_id,v_staff.id,v_today,v_now,'mobile_qr',p_request_key)
      on conflict(staff_id,work_date) do update set checked_in_at=excluded.checked_in_at,source='mobile_qr',check_in_request_key=excluded.check_in_request_key,updated_at=now()
      returning * into v_record;
  else
    if v_record.id is null or v_record.checked_in_at is null then raise exception using errcode='22023',message='check_in_required';end if;
    if v_record.checked_out_at is not null then raise exception using errcode='23505',message='already_checked_out';end if;
    update public.timefit_user_attendance_records set checked_out_at=v_now,source='mobile_qr',check_out_request_key=p_request_key,updated_at=now()
      where id=v_record.id returning * into v_record;
  end if;
  return jsonb_build_object('workDate',v_today,'timezone',v_timezone,'checkedInAt',v_record.checked_in_at,'checkedOutAt',v_record.checked_out_at,'nextAction',case when v_record.checked_in_at is null then 'check_in' when v_record.checked_out_at is null then 'check_out' else 'completed' end,'duplicate',false,'serverTime',v_now,'requestId',p_request_key);
end $$;

create or replace function public.timefit_user_mobile_attendance_today(p_organization_id uuid) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_staff public.timefit_user_staff;v_record public.timefit_user_attendance_records;v_timezone text;v_today date;v_now timestamptz:=now();v_request_id uuid:=gen_random_uuid();
begin
  if auth.uid() is null then raise exception using errcode='42501',message='authentication_required';end if;
  select * into v_staff from public.timefit_user_staff where user_id=auth.uid() and organization_id=p_organization_id limit 1;
  if v_staff.id is null then raise exception using errcode='42501',message='staff_access_denied';end if;
  select coalesce(timezone,'Asia/Seoul') into v_timezone from public.timefit_user_organization_settings where organization_id=p_organization_id;
  v_timezone:=coalesce(v_timezone,'Asia/Seoul');v_today:=(v_now at time zone v_timezone)::date;
  select * into v_record from public.timefit_user_attendance_records where staff_id=v_staff.id and work_date=v_today;
  return jsonb_build_object('workDate',v_today,'timezone',v_timezone,'checkedInAt',v_record.checked_in_at,'checkedOutAt',v_record.checked_out_at,'nextAction',case when v_record.checked_in_at is null then 'check_in' when v_record.checked_out_at is null then 'check_out' else 'completed' end,'serverTime',v_now,'requestId',v_request_id);
end $$;

create or replace function public.timefit_user_mobile_cancel_leave(
  p_organization_id uuid,
  p_request_id uuid,
  p_request_key uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_staff_id uuid;v_request public.timefit_user_leave_requests;
begin
  if p_request_key is null then raise exception using errcode='22023',message='invalid_cancel_request';end if;
  if not public.timefit_user_mobile_can_access_organization(p_organization_id) then raise exception using errcode='42501',message='organization_access_denied';end if;
  select id into v_staff_id from public.timefit_user_staff where organization_id=p_organization_id and user_id=auth.uid() limit 1;
  select * into v_request from public.timefit_user_leave_requests where id=p_request_id and organization_id=p_organization_id and staff_id=v_staff_id for update;
  if v_request.id is null then raise exception using errcode='42501',message='leave_request_access_denied';end if;
  if v_request.mobile_cancel_request_key=p_request_key then return to_jsonb(v_request)||jsonb_build_object('duplicate',true);end if;
  if v_request.status='cancelled' then return to_jsonb(v_request)||jsonb_build_object('duplicate',true);end if;
  if v_request.status<>'pending' then raise exception using errcode='22023',message='leave_request_not_cancellable';end if;
  update public.timefit_user_leave_requests set status='cancelled',mobile_cancel_request_key=p_request_key,updated_at=now() where id=v_request.id returning * into v_request;
  return to_jsonb(v_request)||jsonb_build_object('duplicate',false);
end $$;

revoke all on function public.timefit_user_mobile_qr_attendance(text,text,uuid) from public;
revoke all on function public.timefit_user_mobile_cancel_leave(uuid,uuid,uuid) from public;
grant execute on function public.timefit_user_mobile_qr_attendance(text,text,uuid) to authenticated;
grant execute on function public.timefit_user_mobile_cancel_leave(uuid,uuid,uuid) to authenticated;
select pg_notify('pgrst','reload schema');
