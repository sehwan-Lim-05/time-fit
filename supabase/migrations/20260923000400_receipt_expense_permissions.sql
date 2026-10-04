-- Granular expense permissions and cost-center scopes for delegated managers.

do $$
declare constraint_name text;
begin
  select conname into constraint_name from pg_constraint
  where conrelid='public.timefit_user_management_permissions'::regclass
    and contype='c' and pg_get_constraintdef(oid) like '%permission_code%';
  if constraint_name is not null then
    execute format('alter table public.timefit_user_management_permissions drop constraint %I',constraint_name);
  end if;
end $$;

alter table public.timefit_user_management_permissions
  add constraint timefit_user_management_permissions_code_check
  check (permission_code in (
    'dashboard.view','attendance.view','schedule.view','schedule.manage',
    'leave.view','leave.review','employee.view','payroll.view',
    'finance.view','expense.manage','expense.receipt.review','expense.card.manage',
    'expense.closeout.manage','expense.export',
    'sales.view','sales.sync','settings.manage'
  ));

create table if not exists public.timefit_user_management_cost_center_scopes (
  management_account_id uuid not null references public.timefit_user_management_accounts(id) on delete cascade,
  cost_center_id uuid not null references public.timefit_user_cost_centers(id) on delete cascade,
  primary key (management_account_id,cost_center_id)
);
alter table public.timefit_user_management_cost_center_scopes enable row level security;

create policy "management cost center scopes owner or self read"
  on public.timefit_user_management_cost_center_scopes for select
  using (exists(
    select 1 from public.timefit_user_management_accounts account
    where account.id=management_account_id
      and (account.user_id=auth.uid() or public.timefit_user_is_organization_owner(account.organization_id))
  ));
grant select on public.timefit_user_management_cost_center_scopes to authenticated;
grant all on public.timefit_user_management_cost_center_scopes to service_role;

create or replace function public.timefit_user_management_can_access_cost_center(
  p_organization_id uuid,
  p_cost_center_id uuid
)
returns boolean language sql stable security definer set search_path=public as $$
  select p_cost_center_id is null or exists(
    select 1 from public.timefit_user_management_accounts account
    join public.timefit_user_cost_centers target
      on target.id=p_cost_center_id and target.organization_id=p_organization_id
    where account.organization_id=p_organization_id and account.user_id=auth.uid() and account.status='active'
      and (
        not exists(select 1 from public.timefit_user_management_cost_center_scopes scope where scope.management_account_id=account.id)
        or exists(
          select 1 from public.timefit_user_management_cost_center_scopes scope
          join public.timefit_user_cost_centers granted on granted.id=scope.cost_center_id
          where scope.management_account_id=account.id
            and (granted.id=target.id or granted.id=target.parent_id)
        )
      )
  );
$$;

create or replace function public.timefit_user_can_review_receipt(
  p_organization_id uuid,
  p_cost_center_id uuid
)
returns boolean language sql stable security definer set search_path=public as $$
  select public.timefit_user_is_organization_owner(p_organization_id)
    or (
      public.timefit_user_has_management_permission(p_organization_id,'expense.receipt.review')
      and public.timefit_user_management_can_access_cost_center(p_organization_id,p_cost_center_id)
    );
$$;

drop policy if exists "manager reads finance document pages" on public.timefit_user_finance_document_pages;
create policy "scoped manager reads finance document pages"
  on public.timefit_user_finance_document_pages for select
  using (exists(
    select 1 from public.timefit_user_finance_documents document
    where document.id=document_id and (
      public.timefit_user_is_organization_owner(document.organization_id)
      or (
        (
          public.timefit_user_has_management_permission(document.organization_id,'finance.view')
          or public.timefit_user_has_management_permission(document.organization_id,'expense.receipt.review')
          or public.timefit_user_has_management_permission(document.organization_id,'expense.manage')
        )
        and public.timefit_user_management_can_access_cost_center(document.organization_id,document.cost_center_id)
      )
    )
  ));

drop policy if exists "manager reads receipt extractions" on public.timefit_user_receipt_extractions;
create policy "scoped manager reads receipt extractions"
  on public.timefit_user_receipt_extractions for select
  using (exists(
    select 1 from public.timefit_user_finance_documents document
    where document.id=document_id and (
      public.timefit_user_is_organization_owner(document.organization_id)
      or (
        (
          public.timefit_user_has_management_permission(document.organization_id,'finance.view')
          or public.timefit_user_has_management_permission(document.organization_id,'expense.receipt.review')
          or public.timefit_user_has_management_permission(document.organization_id,'expense.manage')
        )
        and public.timefit_user_management_can_access_cost_center(document.organization_id,document.cost_center_id)
      )
    )
  ));

drop policy if exists "manager reads receipt line items" on public.timefit_user_receipt_line_items;
create policy "scoped manager reads receipt line items"
  on public.timefit_user_receipt_line_items for select
  using (public.timefit_user_is_organization_owner(organization_id) or (
    (
      public.timefit_user_has_management_permission(organization_id,'finance.view')
      or public.timefit_user_has_management_permission(organization_id,'expense.receipt.review')
      or public.timefit_user_has_management_permission(organization_id,'expense.manage')
    ) and public.timefit_user_management_can_access_cost_center(organization_id,cost_center_id)
  ));

grant execute on function public.timefit_user_management_can_access_cost_center(uuid,uuid) to authenticated;
grant execute on function public.timefit_user_can_review_receipt(uuid,uuid) to authenticated;

select pg_notify('pgrst','reload schema');
