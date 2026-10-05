-- ATT-01: one QR attendance source for the existing web and mobile workforce.
-- A timefit_user organization is the current workplace boundary. Attendance
-- continues to live only in timefit_user_attendance_records.

create table if not exists public.timefit_user_attendance_qr_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index if not exists timefit_attendance_qr_one_active_session
  on public.timefit_user_attendance_qr_sessions(organization_id)
  where revoked_at is null;

alter table public.timefit_user_mobile_attendance_qr_tokens
  add column if not exists display_session_id uuid references public.timefit_user_attendance_qr_sessions(id) on delete cascade,
  add column if not exists issued_at timestamptz not null default now(),
  add column if not exists revoked_at timestamptz;

alter table public.timefit_user_attendance_records
  add column if not exists status text not null default 'completed',
  add column if not exists needs_review boolean not null default false;

update public.timefit_user_attendance_records
set status=case when checked_in_at is not null and checked_out_at is null then 'working' else 'completed' end
where status='completed';
alter table public.timefit_user_attendance_records alter column status set default 'working';

create or replace function public.timefit_user_sync_attendance_status() returns trigger language plpgsql set search_path=public as $$
begin
  new.status:=case when new.needs_review then 'needs_review' when new.checked_out_at is not null then 'completed' else 'working' end;
  return new;
end $$;
drop trigger if exists timefit_user_attendance_status_sync on public.timefit_user_attendance_records;
create trigger timefit_user_attendance_status_sync before insert or update of checked_in_at,checked_out_at,needs_review
  on public.timefit_user_attendance_records for each row execute procedure public.timefit_user_sync_attendance_status();

alter table public.timefit_user_attendance_qr_sessions enable row level security;
grant all on public.timefit_user_attendance_qr_sessions to service_role;

create or replace function public.timefit_user_rotate_attendance_qr(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_session public.timefit_user_attendance_qr_sessions;
  v_token text:=encode(extensions.gen_random_bytes(32),'hex');
  v_now timestamptz:=clock_timestamp();
  v_expires timestamptz:=v_now+interval '90 seconds';
  v_name text;
begin
  select * into v_session from public.timefit_user_attendance_qr_sessions where id=p_session_id and revoked_at is null for update;
  if v_session.id is null then raise exception using errcode='22023',message='qr_session_not_found';end if;
  if not public.timefit_user_has_membership_role(v_session.organization_id,array['manager']::public.timefit_user_role[]) then
    raise exception using errcode='42501',message='qr_session_manager_required';
  end if;
  select name into v_name from public.timefit_user_organizations where id=v_session.organization_id;
  update public.timefit_user_mobile_attendance_qr_tokens set is_active=false,revoked_at=v_now
    where display_session_id=p_session_id and is_active and expires_at<=v_now-interval '30 seconds';
  insert into public.timefit_user_mobile_attendance_qr_tokens(
    organization_id,display_session_id,token_hash,work_date,issued_at,expires_at,is_active,created_by
  ) values (
    v_session.organization_id,p_session_id,encode(extensions.digest(v_token,'sha256'),'hex'),
    (v_now at time zone coalesce((select timezone from public.timefit_user_organization_settings where organization_id=v_session.organization_id),'Asia/Seoul'))::date,
    v_now,v_expires,true,auth.uid()
  );
  return jsonb_build_object('sessionId',p_session_id,'organizationId',v_session.organization_id,'organizationName',v_name,'token',v_token,'issuedAt',v_now,'expiresAt',v_expires,'rotateAfterSeconds',60);
end $$;

create or replace function public.timefit_user_start_attendance_qr(p_organization_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_session_id uuid;v_now timestamptz:=clock_timestamp();
begin
  if not public.timefit_user_has_membership_role(p_organization_id,array['manager']::public.timefit_user_role[]) then
    raise exception using errcode='42501',message='qr_session_manager_required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,1));
  update public.timefit_user_attendance_qr_sessions set revoked_at=v_now where organization_id=p_organization_id and revoked_at is null;
  update public.timefit_user_mobile_attendance_qr_tokens set is_active=false,revoked_at=v_now where organization_id=p_organization_id and is_active;
  insert into public.timefit_user_attendance_qr_sessions(organization_id,created_by) values(p_organization_id,auth.uid()) returning id into v_session_id;
  return public.timefit_user_rotate_attendance_qr(v_session_id);
end $$;

create or replace function public.timefit_user_stop_attendance_qr(p_session_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_org uuid;v_now timestamptz:=clock_timestamp();
begin
  select organization_id into v_org from public.timefit_user_attendance_qr_sessions where id=p_session_id and revoked_at is null for update;
  if v_org is null then return;end if;
  if not public.timefit_user_has_membership_role(v_org,array['manager']::public.timefit_user_role[]) then
    raise exception using errcode='42501',message='qr_session_manager_required';
  end if;
  update public.timefit_user_attendance_qr_sessions set revoked_at=v_now where id=p_session_id;
  update public.timefit_user_mobile_attendance_qr_tokens set is_active=false,revoked_at=v_now where display_session_id=p_session_id and is_active;
end $$;

create or replace function public.timefit_user_mobile_qr_attendance(p_token text,p_request_key uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_qr public.timefit_user_mobile_attendance_qr_tokens;
  v_staff public.timefit_user_staff;
  v_record public.timefit_user_attendance_records;
  v_schedule public.timefit_user_work_schedules;
  v_timezone text;
  v_org_name text;
  v_today date;
  v_now timestamptz:=clock_timestamp();
  v_action text;
  v_duplicate boolean:=false;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='authentication_required';end if;
  if nullif(trim(p_token),'') is null or p_request_key is null then raise exception using errcode='22023',message='invalid_attendance_request';end if;

  select token.* into v_qr from public.timefit_user_mobile_attendance_qr_tokens token
    where token.token_hash=encode(extensions.digest(trim(p_token),'sha256'),'hex') limit 1;
  if v_qr.id is null then raise exception using errcode='22023',message='invalid_or_expired_qr';end if;

  select * into v_staff from public.timefit_user_staff where organization_id=v_qr.organization_id and user_id=auth.uid() limit 1;
  if v_staff.id is null then raise exception using errcode='42501',message='workplace_access_denied';end if;
  perform pg_advisory_xact_lock(hashtextextended(v_staff.id::text,0));

  select coalesce(settings.timezone,'Asia/Seoul'),organization.name into v_timezone,v_org_name
    from public.timefit_user_organizations organization
    left join public.timefit_user_organization_settings settings on settings.organization_id=organization.id
    where organization.id=v_qr.organization_id;
  v_timezone:=coalesce(v_timezone,'Asia/Seoul');v_today:=(v_now at time zone v_timezone)::date;

  select * into v_record from public.timefit_user_attendance_records
    where staff_id=v_staff.id and (check_in_request_key=p_request_key or check_out_request_key=p_request_key)
    order by work_date desc limit 1 for update;
  if v_record.id is not null then
    v_action:=case when v_record.check_out_request_key=p_request_key then 'check_out' else 'check_in' end;
    return jsonb_build_object('action',v_action,'duplicate',true,'workDate',v_record.work_date,'timezone',v_timezone,'organizationId',v_qr.organization_id,'workplaceName',v_org_name,'checkedInAt',v_record.checked_in_at,'checkedOutAt',v_record.checked_out_at,'nextAction',case when v_record.checked_out_at is null then 'check_out' else 'completed' end,'status',v_record.status,'needsReview',v_record.needs_review,'serverTime',v_now,'requestId',p_request_key);
  end if;

  -- A retry with the same request key may confirm an earlier write even after
  -- the photographed QR expires. New writes still require an active session.
  if not (v_qr.is_active and v_qr.revoked_at is null and v_qr.expires_at>v_now and exists(
    select 1 from public.timefit_user_attendance_qr_sessions session
    where session.id=v_qr.display_session_id and session.revoked_at is null
  )) then
    raise exception using errcode='22023',message='invalid_or_expired_qr';
  end if;

  select * into v_record from public.timefit_user_attendance_records
    where staff_id=v_staff.id and checked_in_at is not null and checked_out_at is null
    order by checked_in_at desc limit 1 for update;

  if v_record.id is not null and v_now-v_record.checked_in_at>interval '18 hours' then
    update public.timefit_user_attendance_records set status='needs_review',needs_review=true,updated_at=v_now where id=v_record.id returning * into v_record;
    return jsonb_build_object('action','review_required','duplicate',false,'workDate',v_record.work_date,'timezone',v_timezone,'organizationId',v_qr.organization_id,'workplaceName',v_org_name,'checkedInAt',v_record.checked_in_at,'checkedOutAt',null,'nextAction','review_required','status','needs_review','needsReview',true,'serverTime',v_now,'requestId',p_request_key);
  end if;

  if v_record.id is not null then
    if v_now-v_record.checked_in_at<interval '60 seconds' then
      return jsonb_build_object('action','check_in','duplicate',true,'workDate',v_record.work_date,'timezone',v_timezone,'organizationId',v_qr.organization_id,'workplaceName',v_org_name,'checkedInAt',v_record.checked_in_at,'checkedOutAt',null,'nextAction','check_out','status',v_record.status,'needsReview',v_record.needs_review,'serverTime',v_now,'requestId',p_request_key);
    end if;
    update public.timefit_user_attendance_records set checked_out_at=v_now,check_out_request_key=p_request_key,status='completed',updated_at=v_now where id=v_record.id returning * into v_record;
    v_action:='check_out';
  else
    select * into v_record from public.timefit_user_attendance_records where staff_id=v_staff.id and work_date=v_today for update;
    if v_record.id is not null then
      return jsonb_build_object('action','check_out','duplicate',true,'workDate',v_record.work_date,'timezone',v_timezone,'organizationId',v_qr.organization_id,'workplaceName',v_org_name,'checkedInAt',v_record.checked_in_at,'checkedOutAt',v_record.checked_out_at,'nextAction','completed','status',v_record.status,'needsReview',v_record.needs_review,'serverTime',v_now,'requestId',p_request_key);
    end if;
    select * into v_schedule from public.timefit_user_work_schedules where staff_id=v_staff.id and work_date=v_today and status='published' and not is_day_off limit 1;
    insert into public.timefit_user_attendance_records(organization_id,staff_id,work_date,checked_in_at,source,check_in_request_key,status,needs_review)
      values(v_qr.organization_id,v_staff.id,v_today,v_now,'mobile_qr',p_request_key,case when v_schedule.id is null then 'needs_review' else 'working' end,v_schedule.id is null)
      returning * into v_record;
    v_action:='check_in';
  end if;

  return jsonb_build_object('action',v_action,'duplicate',v_duplicate,'workDate',v_record.work_date,'timezone',v_timezone,'organizationId',v_qr.organization_id,'workplaceName',v_org_name,'checkedInAt',v_record.checked_in_at,'checkedOutAt',v_record.checked_out_at,'nextAction',case when v_record.checked_out_at is null then 'check_out' else 'completed' end,'status',v_record.status,'needsReview',v_record.needs_review,'serverTime',v_now,'requestId',p_request_key);
end $$;

create or replace function public.timefit_user_mobile_attendance_today(p_organization_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_staff public.timefit_user_staff;
  v_record public.timefit_user_attendance_records;
  v_timezone text;
  v_name text;
  v_today date;
  v_now timestamptz:=clock_timestamp();
  v_request_id uuid:=gen_random_uuid();
begin
  if auth.uid() is null then raise exception using errcode='42501',message='authentication_required';end if;
  select * into v_staff from public.timefit_user_staff where user_id=auth.uid() and organization_id=p_organization_id limit 1;
  if v_staff.id is null then raise exception using errcode='42501',message='staff_access_denied';end if;
  select coalesce(settings.timezone,'Asia/Seoul'),organization.name into v_timezone,v_name
    from public.timefit_user_organizations organization
    left join public.timefit_user_organization_settings settings on settings.organization_id=organization.id
    where organization.id=p_organization_id;
  v_timezone:=coalesce(v_timezone,'Asia/Seoul');v_today:=(v_now at time zone v_timezone)::date;
  select * into v_record from public.timefit_user_attendance_records
    where staff_id=v_staff.id and checked_in_at is not null and checked_out_at is null
    order by checked_in_at desc limit 1;
  if v_record.id is null then
    select * into v_record from public.timefit_user_attendance_records where staff_id=v_staff.id and work_date=v_today;
  end if;
  return jsonb_build_object('workDate',coalesce(v_record.work_date,v_today),'timezone',v_timezone,'organizationId',p_organization_id,'workplaceName',v_name,'checkedInAt',v_record.checked_in_at,'checkedOutAt',v_record.checked_out_at,'nextAction',case when v_record.id is null then 'check_in' when v_record.checked_in_at is not null and v_record.checked_out_at is null and (v_record.needs_review or v_now-v_record.checked_in_at>interval '18 hours') then 'review_required' when v_record.checked_in_at is not null and v_record.checked_out_at is null then 'check_out' else 'completed' end,'status',coalesce(v_record.status,'working'),'needsReview',coalesce(v_record.needs_review,false),'serverTime',v_now,'requestId',v_request_id);
end $$;

drop function if exists public.timefit_user_mobile_qr_attendance(text,text,uuid);
revoke all on function public.timefit_user_start_attendance_qr(uuid),public.timefit_user_rotate_attendance_qr(uuid),public.timefit_user_stop_attendance_qr(uuid),public.timefit_user_mobile_qr_attendance(text,uuid),public.timefit_user_mobile_attendance_today(uuid) from public;
grant execute on function public.timefit_user_start_attendance_qr(uuid),public.timefit_user_rotate_attendance_qr(uuid),public.timefit_user_stop_attendance_qr(uuid),public.timefit_user_mobile_qr_attendance(text,uuid),public.timefit_user_mobile_attendance_today(uuid) to authenticated;
select pg_notify('pgrst','reload schema');
