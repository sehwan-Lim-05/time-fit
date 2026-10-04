-- Finance permissions are organization-wide; operational category scopes still
-- constrain write policies and the operational UI. Payroll view is read-only.
do $$
declare constraint_name text;
begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'public.timefit_user_management_permissions'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%permission_code%';
  if constraint_name is not null then
    execute format('alter table public.timefit_user_management_permissions drop constraint %I', constraint_name);
  end if;
end $$;

alter table public.timefit_user_management_permissions
  add constraint timefit_user_management_permissions_code_check
  check (permission_code in (
    'dashboard.view','attendance.view','schedule.view','schedule.manage',
    'leave.view','leave.review','employee.view','payroll.view',
    'finance.view','expense.manage','sales.view','sales.sync','settings.manage'
  ));

drop policy if exists "delegated payroll staff read" on public.timefit_user_staff;
create policy "delegated payroll staff read" on public.timefit_user_staff
  for select using (public.timefit_user_has_management_permission(organization_id,'payroll.view'));

drop policy if exists "delegated payroll attendance read" on public.timefit_user_attendance_records;
create policy "delegated payroll attendance read" on public.timefit_user_attendance_records
  for select using (public.timefit_user_has_management_permission(organization_id,'payroll.view'));

drop policy if exists "delegated payroll schedule read" on public.timefit_user_work_schedules;
create policy "delegated payroll schedule read" on public.timefit_user_work_schedules
  for select using (public.timefit_user_has_management_permission(organization_id,'payroll.view'));

drop policy if exists "delegated payroll leave read" on public.timefit_user_leave_requests;
create policy "delegated payroll leave read" on public.timefit_user_leave_requests
  for select using (public.timefit_user_has_management_permission(organization_id,'payroll.view'));

drop policy if exists "delegated payroll contracts read" on public.timefit_user_payroll_contracts;
create policy "delegated payroll contracts read" on public.timefit_user_payroll_contracts
  for select using (public.timefit_user_has_management_permission(organization_id,'payroll.view'));

drop policy if exists "delegated payroll draft lines read" on public.timefit_user_payroll_draft_lines;
create policy "delegated payroll draft lines read" on public.timefit_user_payroll_draft_lines
  for select using (exists (
    select 1 from public.timefit_user_payroll_drafts draft
    where draft.id = payroll_draft_id
      and public.timefit_user_has_management_permission(draft.organization_id,'payroll.view')
  ));

select pg_notify('pgrst','reload schema');
