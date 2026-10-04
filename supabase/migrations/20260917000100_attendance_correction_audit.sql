-- Corrections are atomic, owner-only, audited, and reject stale forms.
create table if not exists public.timefit_user_attendance_corrections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  staff_id uuid not null references public.timefit_user_staff(id) on delete cascade,
  work_date date not null,
  before_record jsonb,
  after_record jsonb not null,
  reason text not null,
  corrected_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
-- Some installations created this audit table before recording this migration.
-- Never silently adopt an incompatible pre-existing relation.
do $$
declare v_columns text[];
begin
  select array_agg(column_name order by column_name) into v_columns
  from information_schema.columns
  where table_schema = 'public' and table_name = 'timefit_user_attendance_corrections';
  if v_columns is distinct from array[
    'after_record', 'before_record', 'corrected_by', 'created_at', 'id',
    'organization_id', 'reason', 'staff_id', 'work_date'
  ]::text[] then
    raise exception 'Existing attendance correction audit schema differs; inspect before migration';
  end if;
end $$;
alter table public.timefit_user_attendance_corrections enable row level security;
drop policy if exists "owner reads attendance corrections" on public.timefit_user_attendance_corrections;
create policy "owner reads attendance corrections" on public.timefit_user_attendance_corrections
for select to authenticated using (exists (
  select 1 from public.timefit_user_organizations o where o.id = organization_id and o.owner_id = auth.uid()
));
grant select on public.timefit_user_attendance_corrections to authenticated;

create or replace function public.timefit_user_correct_attendance(
  p_organization_id uuid, p_staff_id uuid, p_work_date date,
  p_checked_in_at timestamptz, p_checked_out_at timestamptz,
  p_reason text, p_expected_updated_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_before public.timefit_user_attendance_records; v_after public.timefit_user_attendance_records;
begin
  if auth.uid() is null or not exists(select 1 from public.timefit_user_organizations where id = p_organization_id and owner_id = auth.uid()) then
    raise exception '최고관리자만 근태를 정정할 수 있습니다.';
  end if;
  -- Serialize even when the attendance row does not exist yet.
  perform 1 from public.timefit_user_staff where id = p_staff_id and organization_id = p_organization_id for update;
  if not found then raise exception '직원 정보를 찾을 수 없습니다.'; end if;
  if p_work_date is null or p_work_date > (now() at time zone 'Asia/Seoul')::date
    or p_checked_in_at is null or (p_checked_in_at at time zone 'Asia/Seoul')::date <> p_work_date
    or p_checked_in_at > now() or p_checked_out_at > now()
    or (p_checked_out_at is not null and (p_checked_out_at <= p_checked_in_at or p_checked_out_at - p_checked_in_at > interval '48 hours'))
    or length(trim(coalesce(p_reason, ''))) < 2 or length(p_reason) > 500 then
    raise exception '근무일, 출퇴근 시각과 정정 사유를 확인해 주세요.';
  end if;
  select * into v_before from public.timefit_user_attendance_records where staff_id = p_staff_id and work_date = p_work_date for update;
  if v_before.updated_at is distinct from p_expected_updated_at then
    raise exception '기록이 변경되었습니다. 새로고침 후 다시 확인해 주세요.';
  end if;
  if v_before.id is null then
    -- A tablet may create a row concurrently without locking the staff row.
    -- Never overwrite that new source record through an upsert.
    begin
      insert into public.timefit_user_attendance_records(organization_id, staff_id, work_date, checked_in_at, checked_out_at, source)
      values(p_organization_id, p_staff_id, p_work_date, p_checked_in_at, p_checked_out_at, 'manager_correction')
      returning * into v_after;
    exception when unique_violation then
      raise exception '기록이 변경되었습니다. 새로고침 후 다시 확인해 주세요.';
    end;
  else
    update public.timefit_user_attendance_records set checked_in_at = p_checked_in_at,
      checked_out_at = p_checked_out_at, source = 'manager_correction'
    where id = v_before.id returning * into v_after;
  end if;
  insert into public.timefit_user_attendance_corrections(organization_id, staff_id, work_date, before_record, after_record, reason, corrected_by)
  values(p_organization_id, p_staff_id, p_work_date, case when v_before.id is null then null else to_jsonb(v_before) end, to_jsonb(v_after), trim(p_reason), auth.uid());
  return to_jsonb(v_after);
end $$;
revoke all on function public.timefit_user_correct_attendance(uuid,uuid,date,timestamptz,timestamptz,text,timestamptz) from public, anon;
grant execute on function public.timefit_user_correct_attendance(uuid,uuid,date,timestamptz,timestamptz,text,timestamptz) to authenticated;
