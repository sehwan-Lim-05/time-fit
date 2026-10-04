-- Temporary Butter Villa Gangneung policy. Remove this column, trigger and
-- function when the workplace-specific full-time break rule is retired.
alter table public.timefit_user_organization_settings
  add column if not exists temporary_fulltime_break_minutes integer
  check (temporary_fulltime_break_minutes between 0 and 480);

insert into public.timefit_user_organization_settings (organization_id, workplace_name, temporary_fulltime_break_minutes)
select id, name, 120
from public.timefit_user_organizations
where trim(name) = '버터빌라 강릉'
on conflict (organization_id) do nothing;

update public.timefit_user_organization_settings as settings
set temporary_fulltime_break_minutes = 120
from public.timefit_user_organizations as organization
where settings.organization_id = organization.id
  and trim(organization.name) = '버터빌라 강릉'
  and settings.temporary_fulltime_break_minutes is distinct from 120;

create or replace function public.timefit_user_apply_temporary_fulltime_break()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  fixed_minutes integer;
begin
  if new.is_day_off or position('풀타임' in coalesce(new.shift_name, '')) = 0 then
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

drop trigger if exists timefit_user_temporary_fulltime_break on public.timefit_user_work_schedules;
create trigger timefit_user_temporary_fulltime_break
before insert or update of organization_id, shift_name, is_day_off, break_minutes, break_paid
on public.timefit_user_work_schedules
for each row execute function public.timefit_user_apply_temporary_fulltime_break();

update public.timefit_user_work_schedules as schedule
set break_minutes = 120,
    break_paid = false,
    updated_at = now()
from public.timefit_user_organization_settings as settings
where schedule.organization_id = settings.organization_id
  and settings.temporary_fulltime_break_minutes = 120
  and position('풀타임' in coalesce(schedule.shift_name, '')) > 0
  and not schedule.is_day_off
  and (schedule.break_minutes is distinct from 120 or schedule.break_paid is distinct from false);

select pg_notify('pgrst', 'reload schema');
