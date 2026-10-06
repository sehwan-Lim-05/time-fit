-- ATT-02: a workplace QR can be printed or left on a dedicated tablet.
-- It remains valid until a manager explicitly regenerates it. Employee
-- authentication and workplace membership are still checked on every scan.

create table if not exists public.timefit_user_attendance_static_qr (
  organization_id uuid primary key references public.timefit_user_organizations(id) on delete cascade,
  session_id uuid not null references public.timefit_user_attendance_qr_sessions(id) on delete cascade,
  token_value text not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

alter table public.timefit_user_attendance_static_qr enable row level security;
grant all on public.timefit_user_attendance_static_qr to service_role;

create or replace function public.timefit_user_static_attendance_qr(
  p_organization_id uuid,
  p_regenerate boolean default false
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_static public.timefit_user_attendance_static_qr;
  v_session_id uuid;
  v_token text;
  v_now timestamptz:=clock_timestamp();
  v_name text;
begin
  if not public.timefit_user_has_membership_role(p_organization_id,array['manager']::public.timefit_user_role[]) then
    raise exception using errcode='42501',message='qr_session_manager_required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,2));
  select name into v_name from public.timefit_user_organizations where id=p_organization_id;
  if v_name is null then raise exception using errcode='22023',message='organization_not_found';end if;

  select * into v_static from public.timefit_user_attendance_static_qr where organization_id=p_organization_id for update;
  if v_static.organization_id is not null and not p_regenerate then
    return jsonb_build_object(
      'sessionId',v_static.session_id,'organizationId',p_organization_id,'organizationName',v_name,
      'token',v_static.token_value,'createdAt',v_static.created_at,'persistent',true
    );
  end if;

  if v_static.organization_id is not null then
    update public.timefit_user_mobile_attendance_qr_tokens set is_active=false,revoked_at=v_now
      where display_session_id=v_static.session_id and is_active;
    update public.timefit_user_attendance_qr_sessions set revoked_at=v_now where id=v_static.session_id;
    delete from public.timefit_user_attendance_static_qr where organization_id=p_organization_id;
  end if;

  -- Remove an abandoned rotating display before creating the one persistent
  -- workplace session required by the existing attendance validator.
  update public.timefit_user_attendance_qr_sessions set revoked_at=v_now
    where organization_id=p_organization_id and revoked_at is null;
  update public.timefit_user_mobile_attendance_qr_tokens set is_active=false,revoked_at=v_now
    where organization_id=p_organization_id and is_active;

  insert into public.timefit_user_attendance_qr_sessions(organization_id,created_by)
    values(p_organization_id,auth.uid()) returning id into v_session_id;
  v_token:=encode(extensions.gen_random_bytes(32),'hex');
  insert into public.timefit_user_mobile_attendance_qr_tokens(
    organization_id,display_session_id,token_hash,work_date,issued_at,expires_at,is_active,created_by
  ) values(
    p_organization_id,v_session_id,encode(extensions.digest(v_token,'sha256'),'hex'),
    (v_now at time zone coalesce((select timezone from public.timefit_user_organization_settings where organization_id=p_organization_id),'Asia/Seoul'))::date,
    v_now,'infinity'::timestamptz,true,auth.uid()
  );
  insert into public.timefit_user_attendance_static_qr(organization_id,session_id,token_value,created_by,created_at)
    values(p_organization_id,v_session_id,v_token,auth.uid(),v_now);
  return jsonb_build_object(
    'sessionId',v_session_id,'organizationId',p_organization_id,'organizationName',v_name,
    'token',v_token,'createdAt',v_now,'persistent',true
  );
end $$;

revoke all on function public.timefit_user_static_attendance_qr(uuid,boolean) from public;
grant execute on function public.timefit_user_static_attendance_qr(uuid,boolean) to authenticated;
select pg_notify('pgrst','reload schema');
