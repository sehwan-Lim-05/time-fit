-- Uses a new version because 20261001000100 is already occupied by a different
-- migration in the linked production project's migration history.
alter table public.timefit_user_feedback_items
  add column if not exists review_source_id uuid,
  add column if not exists source_url text,
  add column if not exists content_hash text,
  add column if not exists reviewer_hash text,
  add column if not exists visit_count integer,
  add column if not exists verification_method text,
  add column if not exists keywords jsonb not null default '[]'::jsonb,
  add column if not exists source_metadata jsonb not null default '{}'::jsonb,
  add column if not exists collected_at timestamptz;

create table if not exists public.timefit_user_review_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  source text not null check (source in ('naver','catchtable','google','kakao','other')),
  external_place_id text not null,
  place_name text,
  search_query text,
  source_url text not null,
  status text not null default 'active' check (status in ('active','paused','degraded')),
  enabled boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  last_collected_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, source, external_place_id)
);

do $$ begin
  alter table public.timefit_user_feedback_items
    add constraint timefit_feedback_review_source_fk
    foreign key (review_source_id) references public.timefit_user_review_sources(id) on delete set null;
exception when duplicate_object then null;
end $$;

create table if not exists public.timefit_user_review_sync_runs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null default gen_random_uuid() unique,
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  review_source_id uuid not null references public.timefit_user_review_sources(id) on delete cascade,
  status text not null default 'running' check (status in ('running','succeeded','partial','failed')),
  trigger_type text not null default 'schedule' check (trigger_type in ('schedule','manual','backfill')),
  fetched_count integer not null default 0,
  upserted_count integer not null default 0,
  error_code text,
  error_message text,
  place_snapshot jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists timefit_feedback_review_source_idx
  on public.timefit_user_feedback_items(review_source_id, occurred_at desc);
create index if not exists timefit_feedback_content_hash_idx
  on public.timefit_user_feedback_items(organization_id, source, content_hash);
create index if not exists timefit_review_sources_org_idx
  on public.timefit_user_review_sources(organization_id, enabled, source);
create index if not exists timefit_review_sync_runs_source_idx
  on public.timefit_user_review_sync_runs(review_source_id, started_at desc);
create index if not exists timefit_review_sync_runs_job_idx
  on public.timefit_user_review_sync_runs(job_id);

create trigger timefit_user_review_sources_updated_at
  before update on public.timefit_user_review_sources
  for each row execute procedure public.set_updated_at();

alter table public.timefit_user_review_sources enable row level security;
alter table public.timefit_user_review_sync_runs enable row level security;

create policy "members read review sources"
  on public.timefit_user_review_sources for select
  using (public.timefit_user_is_member(organization_id));
create policy "managers manage review sources"
  on public.timefit_user_review_sources for all
  using (public.timefit_user_has_membership_role(organization_id,array['manager']::public.timefit_user_role[]))
  with check (public.timefit_user_has_membership_role(organization_id,array['manager']::public.timefit_user_role[]));
create policy "members read review sync runs"
  on public.timefit_user_review_sync_runs for select
  using (public.timefit_user_is_member(organization_id));

grant select, insert, update, delete on public.timefit_user_review_sources to authenticated;
grant select on public.timefit_user_review_sync_runs to authenticated;

select pg_notify('pgrst', 'reload schema');
