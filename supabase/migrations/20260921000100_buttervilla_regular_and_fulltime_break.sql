-- Butter Villa Gangneung: both regular and full-time shifts have a fixed
-- two-hour unpaid break. This replaces the earlier full-time-only trigger.
create or replace function public.timefit_user_apply_temporary_fulltime_break()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  fixed_minutes integer;
  normalized_shift text := regexp_replace(coalesce(new.shift_name, ''), '\s+', '', 'g');
begin
  if new.is_day_off
     or (position('풀타임' in normalized_shift) = 0 and position('일반근무' in normalized_shift) = 0) then
    return new;
  end if;

  select settings.temporary_fulltime_break_minutes into fixed_minutes
  from public.timefit_user_organization_settings as settings
  where settings.organization_id = new.organization_id;

  if fixed_minutes is not null then
    new.break_minutes := fixed_minutes;
    new.break_paid := false;
  end if;
  return new;
end;
$$;

update public.timefit_user_work_schedules as schedule
set break_minutes = 120,
    break_paid = false,
    updated_at = now()
from public.timefit_user_organization_settings as settings,
     public.timefit_user_organizations as organization
where schedule.organization_id = settings.organization_id
  and organization.id = schedule.organization_id
  and trim(organization.name) = '버터빌라 강릉'
  and settings.temporary_fulltime_break_minutes = 120
  and not schedule.is_day_off
  and (
    position('풀타임' in regexp_replace(coalesce(schedule.shift_name, ''), '\s+', '', 'g')) > 0
    or position('일반근무' in regexp_replace(coalesce(schedule.shift_name, ''), '\s+', '', 'g')) > 0
  )
  and (schedule.break_minutes is distinct from 120 or schedule.break_paid is distinct from false);
