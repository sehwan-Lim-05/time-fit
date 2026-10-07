-- UIUX-03: separate per-employee compensation access from aggregate payroll access.

do $$
declare constraint_name text;
begin
  for constraint_name in
    select conname from pg_constraint
    where conrelid = 'public.timefit_user_management_permissions'::regclass
      and contype = 'c' and pg_get_constraintdef(oid) like '%permission_code%'
  loop
    execute format('alter table public.timefit_user_management_permissions drop constraint %I', constraint_name);
  end loop;
end $$;

alter table public.timefit_user_management_permissions
  add constraint timefit_user_management_permissions_code_check
  check (permission_code in (
    'dashboard.view','attendance.view','attendance.manage','attendance.review_correction',
    'schedule.view','schedule.manage','schedule.approve','leave.view','leave.review',
    'payroll.view','employee.view','employee.manage',
    'employee.compensation.view','employee.compensation.manage',
    'sales.view','sales.sync','settings.manage','finance.view','expense.manage',
    'expense.receipt.review','expense.card.manage','expense.closeout.manage','expense.export'
  ));

select pg_notify('pgrst', 'reload schema');
