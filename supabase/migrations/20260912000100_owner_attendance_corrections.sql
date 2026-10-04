create table if not exists public.timefit_user_attendance_correction_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  attendance_record_id uuid not null references public.timefit_user_attendance_records(id) on delete cascade,
  staff_id uuid not null references public.timefit_user_staff(id) on delete cascade,
  work_date date not null,
  before_value jsonb,
  after_value jsonb not null,
  reason text not null,
  corrected_by uuid not null,
  created_at timestamptz not null default now()
);
alter table public.timefit_user_attendance_correction_logs enable row level security;
create policy "organization owner reads attendance corrections" on public.timefit_user_attendance_correction_logs
  for select using (public.timefit_user_is_organization_owner(organization_id));
revoke all on public.timefit_user_attendance_correction_logs from anon;
grant select on public.timefit_user_attendance_correction_logs to authenticated;

create or replace function public.timefit_user_correct_attendance(
  p_organization_id uuid, p_staff_id uuid, p_work_date date,
  p_checked_in_at timestamptz, p_checked_out_at timestamptz, p_reason text
) returns public.timefit_user_attendance_records
language plpgsql security definer set search_path = public as $$
declare v_before public.timefit_user_attendance_records; v_after public.timefit_user_attendance_records;
begin
  if not public.timefit_user_is_organization_owner(p_organization_id) then raise exception 'attendance_correction_forbidden'; end if;
  if not exists (select 1 from public.timefit_user_staff where id=p_staff_id and organization_id=p_organization_id) then raise exception 'staff_not_found'; end if;
  if p_checked_in_at is null then raise exception 'checked_in_required'; end if;
  if p_checked_out_at is not null and p_checked_out_at < p_checked_in_at then raise exception 'checked_out_before_checked_in'; end if;
  if (p_checked_in_at at time zone 'Asia/Seoul')::date <> p_work_date
     or (p_checked_out_at is not null and (p_checked_out_at at time zone 'Asia/Seoul')::date < p_work_date) then
    raise exception 'attendance_date_mismatch';
  end if;
  if length(trim(coalesce(p_reason,''))) < 2 then raise exception 'correction_reason_required'; end if;
  select * into v_before from public.timefit_user_attendance_records where staff_id=p_staff_id and work_date=p_work_date for update;
  insert into public.timefit_user_attendance_records(organization_id,staff_id,work_date,checked_in_at,checked_out_at,source)
  values(p_organization_id,p_staff_id,p_work_date,p_checked_in_at,p_checked_out_at,'owner_correction')
  on conflict(staff_id,work_date) do update set checked_in_at=excluded.checked_in_at,checked_out_at=excluded.checked_out_at,source='owner_correction',updated_at=now()
  returning * into v_after;
  insert into public.timefit_user_attendance_correction_logs(organization_id,attendance_record_id,staff_id,work_date,before_value,after_value,reason,corrected_by)
  values(p_organization_id,v_after.id,p_staff_id,p_work_date,to_jsonb(v_before),to_jsonb(v_after),trim(p_reason),auth.uid());
  return v_after;
end;
$$;
revoke all on function public.timefit_user_correct_attendance(uuid,uuid,date,timestamptz,timestamptz,text) from public, anon;
grant execute on function public.timefit_user_correct_attendance(uuid,uuid,date,timestamptz,timestamptz,text) to authenticated;
