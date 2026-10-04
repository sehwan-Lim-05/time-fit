alter table public.timefit_user_organization_settings
  add column if not exists shift_type_colors jsonb not null default '{"일반 근무":"#16A34A","오픈 근무":"#2563EB","마감 근무":"#7C3AED","오전 근무":"#0EA5E9","오후 근무":"#F97316","풀타임 근무":"#0F9F8F","휴무":"#64748B","연차":"#8B5CF6"}'::jsonb;

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
    'finance.view','expense.manage','settings.manage'
  ));

create policy "delegated settings read"
  on public.timefit_user_organization_settings for select
  using (public.timefit_user_has_management_permission(organization_id,'settings.manage'));

create policy "delegated settings update"
  on public.timefit_user_organization_settings for update
  using (public.timefit_user_has_management_permission(organization_id,'settings.manage'))
  with check (public.timefit_user_has_management_permission(organization_id,'settings.manage'));

select pg_notify('pgrst','reload schema');
