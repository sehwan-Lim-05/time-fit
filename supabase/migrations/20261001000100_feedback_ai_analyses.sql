create table if not exists public.timefit_user_feedback_analyses (
  feedback_item_id uuid primary key references public.timefit_user_feedback_items(id) on delete cascade,
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  sentiment text not null check (sentiment in ('positive','negative','neutral')),
  sentiment_score numeric(5,4) not null default 0 check (sentiment_score between -1 and 1),
  urgency text not null default 'normal' check (urgency in ('urgent','high','normal','reference')),
  summary text not null default '',
  mentions jsonb not null default '[]'::jsonb check (jsonb_typeof(mentions) = 'array'),
  model text,
  model_version text not null,
  input_hash text not null,
  analyzed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists timefit_feedback_analyses_org_idx on public.timefit_user_feedback_analyses(organization_id, analyzed_at desc);
create index if not exists timefit_feedback_analyses_urgency_idx on public.timefit_user_feedback_analyses(organization_id, urgency, analyzed_at desc);
create trigger timefit_user_feedback_analyses_updated_at before update on public.timefit_user_feedback_analyses for each row execute procedure public.set_updated_at();

alter table public.timefit_user_feedback_analyses enable row level security;
create policy "members read feedback analyses" on public.timefit_user_feedback_analyses for select using (public.timefit_user_is_member(organization_id));
revoke all on table public.timefit_user_feedback_analyses from anon;
grant select on table public.timefit_user_feedback_analyses to authenticated;
grant all on table public.timefit_user_feedback_analyses to service_role;
