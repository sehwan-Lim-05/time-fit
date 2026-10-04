-- Keep an immutable audit trail for every POS collection window. The latest
-- timestamp alone cannot prove that a historical report was fully collected.
create table if not exists public.timefit_user_sales_sync_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  merchant_id bigint not null,
  requested_mode text not null check (requested_mode in ('daily', 'range', 'backfill')),
  window_from timestamptz not null,
  window_to timestamptz not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  pages_fetched integer not null default 0 check (pages_fetched >= 0),
  orders_received integer not null default 0 check (orders_received >= 0),
  page_complete boolean not null default false,
  summary_refresh_completed boolean not null default false,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'partial')),
  error_code text,
  error_message text,
  result_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (window_to >= window_from)
);

create index if not exists timefit_user_sales_sync_runs_org_window_idx
  on public.timefit_user_sales_sync_runs
  (organization_id, merchant_id, window_from, window_to, completed_at desc);

alter table public.timefit_user_sales_sync_runs enable row level security;

alter table public.timefit_user_tossplace_daily_sales
  add column if not exists last_source_synced_at timestamptz,
  add column if not exists finalization_status text not null default 'pending',
  add column if not exists revision_number integer not null default 0,
  add column if not exists source_fingerprint text;

alter table public.timefit_user_tossplace_daily_sales
  drop constraint if exists timefit_user_tossplace_daily_sales_finalization_status_check;

alter table public.timefit_user_tossplace_daily_sales
  add constraint timefit_user_tossplace_daily_sales_finalization_status_check
  check (finalization_status in ('pending', 'captured', 'finalized', 'revised', 'incomplete'));

-- Rebuild daily rows without deleting revision history. A changed fingerprint
-- after a finalized capture is exposed as revised instead of silently replacing
-- a value that an operator may already have reviewed.
drop function if exists public.timefit_user_refresh_tossplace_daily_sales(uuid, bigint);

create or replace function public.timefit_user_refresh_tossplace_daily_sales(
  p_organization_id uuid,
  p_merchant_id bigint,
  p_from date,
  p_to date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  with calendar as (
    select day::date as sales_date
    from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') day
  ), aggregated as (
    select
      organization_id,
      merchant_id,
      (ordered_at at time zone 'Asia/Seoul')::date as sales_date,
      count(*)::bigint as order_count,
      count(*) filter (where state = 'COMPLETED')::bigint as completed_order_count,
      coalesce(sum(total_amount) filter (where state = 'COMPLETED'), 0)::bigint as completed_amount,
      count(*) filter (where coalesce(state, '') ilike '%cancel%')::bigint as cancelled_count,
      md5(string_agg(
        concat_ws(':', order_id, coalesce(state, ''), total_amount::text, coalesce(updated_at::text, '')),
        '|' order by order_id
      )) as source_fingerprint
    from public.tossplace_orders
    where organization_id = p_organization_id
      and merchant_id = p_merchant_id
      and ordered_at is not null
      and (ordered_at at time zone 'Asia/Seoul')::date between p_from and p_to
    group by organization_id, merchant_id, (ordered_at at time zone 'Asia/Seoul')::date
  ), source_rows as (
    select
      p_organization_id as organization_id,
      p_merchant_id as merchant_id,
      calendar.sales_date,
      coalesce(aggregated.order_count, 0)::bigint as order_count,
      coalesce(aggregated.completed_order_count, 0)::bigint as completed_order_count,
      coalesce(aggregated.completed_amount, 0)::bigint as completed_amount,
      coalesce(aggregated.cancelled_count, 0)::bigint as cancelled_count,
      coalesce(aggregated.source_fingerprint, md5('empty:' || calendar.sales_date::text)) as source_fingerprint
    from calendar
    left join aggregated using (sales_date)
  )
  insert into public.timefit_user_tossplace_daily_sales (
    organization_id, merchant_id, sales_date, order_count,
    completed_order_count, completed_amount, cancelled_count, refreshed_at,
    last_source_synced_at, finalization_status, revision_number, source_fingerprint
  )
  select
    organization_id, merchant_id, sales_date, order_count,
    completed_order_count, completed_amount, cancelled_count, now(),
    now(), 'captured', 0, source_fingerprint
  from source_rows
  on conflict (organization_id, merchant_id, sales_date) do update set
    order_count = excluded.order_count,
    completed_order_count = excluded.completed_order_count,
    completed_amount = excluded.completed_amount,
    cancelled_count = excluded.cancelled_count,
    refreshed_at = now(),
    last_source_synced_at = now(),
    revision_number = case
      when timefit_user_tossplace_daily_sales.source_fingerprint is distinct from excluded.source_fingerprint
       and timefit_user_tossplace_daily_sales.finalization_status in ('finalized', 'revised')
      then timefit_user_tossplace_daily_sales.revision_number + 1
      else timefit_user_tossplace_daily_sales.revision_number
    end,
    finalization_status = case
      when timefit_user_tossplace_daily_sales.source_fingerprint is distinct from excluded.source_fingerprint
       and timefit_user_tossplace_daily_sales.finalization_status in ('finalized', 'revised')
      then 'revised'
      else 'captured'
    end,
    source_fingerprint = excluded.source_fingerprint;
end;
$$;

revoke all on table public.timefit_user_sales_sync_runs from anon, authenticated;
revoke all on function public.timefit_user_refresh_tossplace_daily_sales(uuid, bigint, date, date) from public;
grant execute on function public.timefit_user_refresh_tossplace_daily_sales(uuid, bigint, date, date) to service_role;

select pg_notify('pgrst', 'reload schema');
