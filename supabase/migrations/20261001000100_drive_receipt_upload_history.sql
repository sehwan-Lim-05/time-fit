create table if not exists public.timefit_user_drive_receipt_uploads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  uploaded_by uuid not null references auth.users(id) on delete cascade,
  drive_file_id text not null unique,
  file_name text not null,
  mime_type text,
  file_size bigint not null default 0 check (file_size >= 0),
  drive_url text not null,
  created_at timestamptz not null default now()
);

create index if not exists timefit_drive_receipt_uploads_org_created_idx
  on public.timefit_user_drive_receipt_uploads(organization_id, created_at desc);

alter table public.timefit_user_drive_receipt_uploads enable row level security;

create policy "users read own drive receipt uploads"
  on public.timefit_user_drive_receipt_uploads for select
  using (
    uploaded_by = auth.uid()
    and exists (
      select 1 from public.timefit_user_memberships membership
      where membership.organization_id = timefit_user_drive_receipt_uploads.organization_id
        and membership.user_id = auth.uid()
    )
  );

grant select on public.timefit_user_drive_receipt_uploads to authenticated;
select pg_notify('pgrst','reload schema');
