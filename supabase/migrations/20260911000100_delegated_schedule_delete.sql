drop policy if exists "delegated schedule scoped delete" on public.timefit_user_work_schedules;

create policy "delegated schedule scoped delete"
on public.timefit_user_work_schedules
for delete
using (
  public.timefit_user_has_management_permission(organization_id, 'schedule.manage')
  and public.timefit_user_management_can_access_staff(organization_id, staff_id)
);
