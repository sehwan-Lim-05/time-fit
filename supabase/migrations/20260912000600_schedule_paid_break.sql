alter table public.timefit_user_work_schedules
  add column if not exists break_paid boolean not null default false;

drop trigger if exists timefit_user_schedule_approval_guard on public.timefit_user_work_schedules;
create trigger timefit_user_schedule_approval_guard
before insert or update of staff_id,work_date,starts_at,ends_at,break_minutes,break_paid,shift_name,is_day_off
on public.timefit_user_work_schedules
for each row execute procedure public.timefit_user_prepare_schedule_approval();

select pg_notify('pgrst','reload schema');
