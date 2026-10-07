-- UIUX-02: grant scoped management access to an existing employee account
-- without changing the employee membership or deleting the employee identity
-- when management access is later revoked.

alter table public.timefit_user_management_accounts
  add column if not exists account_origin text not null default 'standalone'
    check (account_origin in ('standalone','linked_employee'));

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
    'dashboard.view','attendance.view','attendance.manage','schedule.view','schedule.manage','leave.view','leave.review',
    'payroll.view','employee.view','employee.manage','sales.view','sales.sync','settings.manage','finance.view','expense.manage',
    'expense.receipt.review','expense.card.manage','expense.closeout.manage','expense.export'
  ));

create table if not exists public.timefit_user_management_audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  management_account_id uuid references public.timefit_user_management_accounts(id) on delete set null,
  target_user_id uuid not null references auth.users(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  action text not null check (action in ('created','linked','updated','suspended','reactivated','revoked')),
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);

create index if not exists timefit_management_audit_org_created
  on public.timefit_user_management_audit_logs(organization_id, created_at desc);

alter table public.timefit_user_management_audit_logs enable row level security;
create policy "management audit owner read"
  on public.timefit_user_management_audit_logs for select
  using (public.timefit_user_is_organization_owner(organization_id));

grant select on public.timefit_user_management_audit_logs to authenticated;
grant all on public.timefit_user_management_audit_logs to service_role;
