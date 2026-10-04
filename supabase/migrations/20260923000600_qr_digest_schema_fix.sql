-- pgcrypto is installed in the extensions schema. Qualify digest so the QR
-- attendance function remains valid with its restricted public search_path.
create or replace function public.record_qr_attendance(
  p_token text,
  p_action text,
  p_latitude numeric default null,
  p_longitude numeric default null
)
returns public.attendance_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee public.employees;
  v_token public.qr_attendance_tokens;
  v_record public.attendance_records;
  v_now timestamptz := now();
begin
  if p_action not in ('check_in', 'check_out') then raise exception 'invalid_action'; end if;
  select * into v_employee from public.employees where user_id=auth.uid() and status='active' limit 1;
  if v_employee.id is null then raise exception 'employee_not_found'; end if;
  select * into v_token
  from public.qr_attendance_tokens
  where token_hash=encode(extensions.digest(p_token,'sha256'),'hex')
    and is_active and expires_at>v_now
    and work_date=(v_now at time zone 'Asia/Seoul')::date
  limit 1;
  if v_token.id is null then raise exception 'invalid_or_expired_qr'; end if;
  if v_employee.organization_id<>v_token.organization_id then raise exception 'organization_mismatch'; end if;
  if v_employee.workplace_id is not null and v_employee.workplace_id<>v_token.workplace_id then raise exception 'wrong_workplace'; end if;
  select * into v_record from public.attendance_records where employee_id=v_employee.id and work_date=v_token.work_date for update;
  if p_action='check_in' then
    if v_record.id is not null and v_record.checked_in_at is not null then raise exception 'already_checked_in'; end if;
    insert into public.attendance_records(
      organization_id,employee_id,workplace_id,work_date,checked_in_at,
      check_in_latitude,check_in_longitude,status
    ) values (
      v_employee.organization_id,v_employee.id,v_token.workplace_id,v_token.work_date,v_now,
      p_latitude,p_longitude,'working'
    ) on conflict(employee_id,work_date) do update set
      checked_in_at=excluded.checked_in_at,check_in_latitude=excluded.check_in_latitude,
      check_in_longitude=excluded.check_in_longitude,status='working',updated_at=now()
    returning * into v_record;
  else
    if v_record.id is null or v_record.checked_in_at is null then raise exception 'check_in_required'; end if;
    if v_record.checked_out_at is not null then raise exception 'already_checked_out'; end if;
    update public.attendance_records set
      checked_out_at=v_now,check_out_latitude=p_latitude,check_out_longitude=p_longitude,
      worked_minutes=greatest(0,floor(extract(epoch from (v_now-checked_in_at))/60)::integer-break_minutes),
      status='completed',updated_at=now()
    where id=v_record.id returning * into v_record;
  end if;
  return v_record;
end;
$$;

grant execute on function public.record_qr_attendance(text,text,numeric,numeric) to authenticated;
select pg_notify('pgrst','reload schema');
