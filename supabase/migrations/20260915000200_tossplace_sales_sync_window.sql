-- Record the exact API window covered by a successful sales sync. A generic
-- last_synced_at timestamp is not enough to prove that today's orders were read.
alter table public.tossplace_sync_state
  add column if not exists last_successful_window_from timestamptz,
  add column if not exists last_successful_window_to timestamptz;

create index if not exists tossplace_sync_state_organization_idx
  on public.tossplace_sync_state (organization_id, last_successful_sync_at desc);

select pg_notify('pgrst', 'reload schema');
