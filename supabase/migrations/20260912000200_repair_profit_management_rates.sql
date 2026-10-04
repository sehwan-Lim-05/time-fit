-- Repair environments where the original migration version was recorded but
-- the profit-management settings columns were not created.
alter table public.timefit_user_organization_settings
  add column if not exists corporate_card_fee_rate numeric(7,6) not null default 0.022
    check (corporate_card_fee_rate between 0 and 1),
  add column if not exists revenue_rent_rate numeric(7,6) not null default 0.15
    check (revenue_rent_rate between 0 and 1);

select pg_notify('pgrst', 'reload schema');
