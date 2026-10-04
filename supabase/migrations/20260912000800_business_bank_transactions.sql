create table if not exists public.timefit_user_bank_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  bank_account_id uuid not null references public.timefit_user_business_bank_accounts(id) on delete restrict,
  provider text not null default 'codef',
  provider_transaction_id text not null,
  occurred_at timestamptz not null,
  direction text not null check (direction in ('deposit','withdrawal')),
  amount bigint not null check (amount > 0),
  balance_after bigint,
  description text,
  created_at timestamptz not null default now(),
  unique(organization_id, provider, provider_transaction_id)
);

create index if not exists timefit_bank_transactions_org_date_idx
  on public.timefit_user_bank_transactions(organization_id, occurred_at desc);
create index if not exists timefit_bank_transactions_account_date_idx
  on public.timefit_user_bank_transactions(bank_account_id, occurred_at desc);

alter table public.timefit_user_bank_transactions enable row level security;
drop policy if exists "manager accesses business bank transactions" on public.timefit_user_bank_transactions;
create policy "manager accesses business bank transactions" on public.timefit_user_bank_transactions for all
  using (public.timefit_user_has_membership_role(organization_id,array['manager']::public.timefit_user_role[]))
  with check (public.timefit_user_has_membership_role(organization_id,array['manager']::public.timefit_user_role[]));
grant select, insert, update, delete on public.timefit_user_bank_transactions to authenticated;
select pg_notify('pgrst','reload schema');
