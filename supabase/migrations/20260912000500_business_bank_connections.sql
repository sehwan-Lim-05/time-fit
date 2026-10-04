create table if not exists public.timefit_user_bank_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  provider text not null default 'codef',
  bank_code text not null,
  status text not null default 'authenticating' check (status in ('authenticating','active','degraded','reauth_required','paused','disconnected')),
  credential_reference_encrypted text,
  consent_version text,
  consented_by uuid references auth.users(id) on delete set null,
  consented_at timestamptz,
  last_succeeded_at timestamptz,
  disconnected_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists timefit_bank_connection_active_unique
  on public.timefit_user_bank_connections(organization_id, provider, bank_code)
  where status <> 'disconnected';

create table if not exists public.timefit_user_business_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  connection_id uuid not null references public.timefit_user_bank_connections(id) on delete restrict,
  provider text not null default 'codef',
  provider_account_id text not null,
  account_reference_encrypted text,
  bank_name text not null,
  display_name text not null,
  last4 text not null check (last4 ~ '^[0-9]{4}$'),
  balance bigint,
  currency text not null default 'KRW',
  status text not null default 'active' check (status in ('active','paused','disconnected')),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(connection_id, provider_account_id)
);

alter table public.timefit_user_bank_connections enable row level security;
alter table public.timefit_user_business_bank_accounts enable row level security;

drop policy if exists "manager accesses business bank connections" on public.timefit_user_bank_connections;
create policy "manager accesses business bank connections" on public.timefit_user_bank_connections for all
  using (public.timefit_user_has_membership_role(organization_id,array['manager']::public.timefit_user_role[]))
  with check (public.timefit_user_has_membership_role(organization_id,array['manager']::public.timefit_user_role[]));

drop policy if exists "manager accesses business bank accounts" on public.timefit_user_business_bank_accounts;
create policy "manager accesses business bank accounts" on public.timefit_user_business_bank_accounts for all
  using (public.timefit_user_has_membership_role(organization_id,array['manager']::public.timefit_user_role[]))
  with check (public.timefit_user_has_membership_role(organization_id,array['manager']::public.timefit_user_role[]));

grant select, insert, update, delete on public.timefit_user_bank_connections to authenticated;
grant select, insert, update, delete on public.timefit_user_business_bank_accounts to authenticated;
select pg_notify('pgrst','reload schema');
