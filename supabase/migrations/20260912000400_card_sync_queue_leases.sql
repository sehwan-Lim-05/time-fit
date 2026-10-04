alter table public.timefit_user_card_sync_runs
  add column if not exists lease_owner text,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists heartbeat_at timestamptz;

-- The original import RPC predates the external providers. Preserve its
-- reviewed implementation while extending only the provider allow-list.
do $$
declare
  v_definition text;
  v_updated text;
begin
  select pg_get_functiondef('public.timefit_user_import_card_events(uuid,uuid,text,jsonb)'::regprocedure) into v_definition;
  v_updated := replace(v_definition,
    'if p_provider not in (''csv'',''api'',''manual'',''mock'',''email'')',
    'if p_provider not in (''csv'',''api'',''manual'',''mock'',''email'',''codef'',''hyphen'')');
  if v_updated = v_definition then raise exception 'card_provider_allow_list_patch_failed'; end if;
  execute v_updated;
end $$;

create index if not exists timefit_card_sync_runs_claim_idx
  on public.timefit_user_card_sync_runs(status, lease_expires_at, created_at)
  where status in ('queued','running');

create or replace function public.timefit_user_claim_card_sync_runs(
  p_worker_id text,
  p_limit integer default 1,
  p_lease_seconds integer default 330
)
returns setof public.timefit_user_card_sync_runs
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'forbidden'; end if;
  if nullif(trim(p_worker_id),'') is null then raise exception 'worker_id_required'; end if;

  return query
  with candidates as (
    select id
    from public.timefit_user_card_sync_runs
    where status = 'queued'
       or (status = 'running' and lease_expires_at < now())
    order by case when status = 'queued' then 0 else 1 end, created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit,1),5))
  )
  update public.timefit_user_card_sync_runs runs
  set status = 'running',
      attempt_count = runs.attempt_count + 1,
      lease_owner = p_worker_id,
      lease_expires_at = now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds,330),600))),
      heartbeat_at = now(),
      started_at = coalesce(runs.started_at,now()),
      finished_at = null
  from candidates
  where runs.id = candidates.id
  returning runs.*;
end $$;

revoke all on function public.timefit_user_claim_card_sync_runs(text,integer,integer) from public;
grant execute on function public.timefit_user_claim_card_sync_runs(text,integer,integer) to service_role;

select pg_notify('pgrst','reload schema');
