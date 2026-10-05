create table if not exists public.timefit_user_mobile_attendance_qr_tokens(id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,token_hash text not null unique,work_date date not null,expires_at timestamptz not null,is_active boolean not null default true,created_by uuid references auth.users(id) on delete set null,created_at timestamptz not null default now());
create index if not exists timefit_mobile_qr_active_idx on public.timefit_user_mobile_attendance_qr_tokens(organization_id,work_date,expires_at) where is_active;
alter table public.timefit_user_mobile_attendance_qr_tokens enable row level security;
grant all on public.timefit_user_mobile_attendance_qr_tokens to service_role;

create or replace function public.timefit_user_mobile_qr_attendance(p_token text,p_action text) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_staff public.timefit_user_staff;v_qr public.timefit_user_mobile_attendance_qr_tokens;v_record public.timefit_user_attendance_records;v_timezone text;v_today date;v_now timestamptz:=now();
begin
 if auth.uid() is null then raise exception using errcode='42501',message='authentication_required';end if;
 if p_action not in ('check_in','check_out') then raise exception using errcode='22023',message='invalid_action';end if;
 select * into v_staff from public.timefit_user_staff where user_id=auth.uid() limit 1;if v_staff.id is null then raise exception using errcode='P0002',message='staff_not_found';end if;
 select coalesce(timezone,'Asia/Seoul') into v_timezone from public.timefit_user_organization_settings where organization_id=v_staff.organization_id;v_timezone:=coalesce(v_timezone,'Asia/Seoul');v_today:=(v_now at time zone v_timezone)::date;
 select * into v_qr from public.timefit_user_mobile_attendance_qr_tokens where organization_id=v_staff.organization_id and token_hash=encode(extensions.digest(trim(p_token),'sha256'),'hex') and is_active and work_date=v_today and expires_at>v_now limit 1;
 if v_qr.id is null then raise exception using errcode='22023',message='invalid_or_expired_qr';end if;
 select * into v_record from public.timefit_user_attendance_records where staff_id=v_staff.id and work_date=v_today for update;
 if p_action='check_in' then
  if v_record.checked_in_at is not null then raise exception using errcode='23505',message='already_checked_in';end if;
  insert into public.timefit_user_attendance_records(organization_id,staff_id,work_date,checked_in_at,source) values(v_staff.organization_id,v_staff.id,v_today,v_now,'mobile_qr') on conflict(staff_id,work_date) do update set checked_in_at=excluded.checked_in_at,source='mobile_qr',updated_at=now() returning * into v_record;
 else
  if v_record.id is null or v_record.checked_in_at is null then raise exception using errcode='22023',message='check_in_required';end if;if v_record.checked_out_at is not null then raise exception using errcode='23505',message='already_checked_out';end if;
  update public.timefit_user_attendance_records set checked_out_at=v_now,source='mobile_qr',updated_at=now() where id=v_record.id returning * into v_record;
 end if;
 return jsonb_build_object('workDate',v_today,'checkedInAt',v_record.checked_in_at,'checkedOutAt',v_record.checked_out_at,'nextAction',case when v_record.checked_out_at is null then 'check_out' else 'completed' end);
end $$;

create or replace function public.timefit_user_mobile_attendance_today(p_organization_id uuid) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_staff public.timefit_user_staff;v_record public.timefit_user_attendance_records;v_timezone text;v_today date;
begin
 select * into v_staff from public.timefit_user_staff where user_id=auth.uid() and organization_id=p_organization_id limit 1;if v_staff.id is null then raise exception using errcode='42501',message='staff_access_denied';end if;
 select coalesce(timezone,'Asia/Seoul') into v_timezone from public.timefit_user_organization_settings where organization_id=p_organization_id;v_timezone:=coalesce(v_timezone,'Asia/Seoul');v_today:=(now() at time zone v_timezone)::date;
 select * into v_record from public.timefit_user_attendance_records where staff_id=v_staff.id and work_date=v_today;
 return jsonb_build_object('workDate',v_today,'timezone',v_timezone,'checkedInAt',v_record.checked_in_at,'checkedOutAt',v_record.checked_out_at,'nextAction',case when v_record.checked_in_at is null then 'check_in' when v_record.checked_out_at is null then 'check_out' else 'completed' end);
end $$;
revoke all on function public.timefit_user_mobile_qr_attendance(text,text),public.timefit_user_mobile_attendance_today(uuid) from public;
grant execute on function public.timefit_user_mobile_qr_attendance(text,text),public.timefit_user_mobile_attendance_today(uuid) to authenticated;

