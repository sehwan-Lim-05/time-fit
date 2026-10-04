update public.timefit_user_work_schedules as schedule
set break_paid = false,
    updated_at = now()
from public.timefit_user_organizations as organization
where schedule.organization_id = organization.id
  and trim(organization.name) = '버터빌라 강릉'
  and schedule.break_paid is distinct from false;

select pg_notify('pgrst', 'reload schema');
