-- Receipt evidence V2: hierarchical cost centers, explicit review workflow and
-- multi-page document storage. The migration keeps legacy document columns so
-- the existing UI can continue to read documents during rollout.

create table if not exists public.timefit_user_cost_centers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  parent_id uuid,
  center_type text not null check (center_type in ('department','section')),
  name text not null check (length(trim(name)) between 1 and 80),
  code text,
  staff_category_id uuid references public.timefit_user_staff_categories(id) on delete set null,
  status text not null default 'active' check (status in ('active','archived')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  check ((center_type = 'department' and parent_id is null) or (center_type = 'section' and parent_id is not null))
);

alter table public.timefit_user_cost_centers
  drop constraint if exists timefit_user_cost_centers_parent_id_fkey;
alter table public.timefit_user_cost_centers
  add constraint timefit_user_cost_centers_parent_org_fkey
  foreign key (parent_id, organization_id)
  references public.timefit_user_cost_centers(id, organization_id)
  on delete restrict;

create unique index if not exists timefit_cost_centers_active_name_unique
  on public.timefit_user_cost_centers(organization_id, coalesce(parent_id,'00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  where status = 'active';
create unique index if not exists timefit_cost_centers_staff_category_unique
  on public.timefit_user_cost_centers(organization_id, staff_category_id)
  where staff_category_id is not null and status = 'active';
create index if not exists timefit_cost_centers_tree_idx
  on public.timefit_user_cost_centers(organization_id, parent_id, sort_order, name);

create or replace function public.timefit_user_validate_cost_center_parent()
returns trigger language plpgsql set search_path=public as $$
declare v_parent public.timefit_user_cost_centers;
begin
  if new.center_type = 'department' then return new; end if;
  select * into v_parent from public.timefit_user_cost_centers
  where id = new.parent_id and organization_id = new.organization_id;
  if v_parent.id is null or v_parent.center_type <> 'department' or v_parent.status <> 'active' then
    raise exception 'invalid_cost_center_parent';
  end if;
  return new;
end $$;

drop trigger if exists timefit_validate_cost_center_parent on public.timefit_user_cost_centers;
create trigger timefit_validate_cost_center_parent
before insert or update of parent_id,center_type,organization_id,status
on public.timefit_user_cost_centers for each row
execute procedure public.timefit_user_validate_cost_center_parent();

insert into public.timefit_user_cost_centers(
  organization_id, center_type, name, code, staff_category_id, sort_order
)
select category.organization_id, 'department', category.name,
  'staff-category-' || category.id::text, category.id, coalesce(category.sort_order,0)
from public.timefit_user_staff_categories category
where not exists (
  select 1 from public.timefit_user_cost_centers center
  where center.organization_id = category.organization_id
    and center.staff_category_id = category.id
    and center.status = 'active'
);

alter table public.timefit_user_finance_documents
  add column if not exists cost_center_id uuid references public.timefit_user_cost_centers(id) on delete set null,
  add column if not exists payment_method text,
  add column if not exists review_status text not null default 'submitted',
  add column if not exists submitted_at timestamptz,
  add column if not exists submitter_confirmed_at timestamptz,
  add column if not exists change_requested_at timestamptz,
  add column if not exists change_request_reason text,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists duplicate_of_document_id uuid references public.timefit_user_finance_documents(id) on delete set null,
  add column if not exists page_count integer not null default 1,
  add column if not exists capture_metadata jsonb not null default '{}'::jsonb;

alter table public.timefit_user_finance_documents
  drop constraint if exists timefit_user_finance_documents_payment_method_check,
  drop constraint if exists timefit_user_finance_documents_review_status_check,
  drop constraint if exists timefit_user_finance_documents_page_count_check,
  drop constraint if exists timefit_user_finance_documents_processing_status_check;

update public.timefit_user_finance_documents document
set review_status = case
    when document.processing_status = 'failed' then 'submitter_review'
    when document.processing_status = 'review_required' then 'manager_review'
    when document.processing_status = 'matched' and exists (
      select 1 from public.timefit_user_expense_matches match
      where match.document_id = document.id and match.status = 'confirmed'
    ) then 'approved'
    when document.processing_status = 'matched' then 'manager_review'
    else 'submitted'
  end,
  processing_status = case document.processing_status
    when 'not_requested' then 'uploaded'
    when 'review_required' then 'ready'
    when 'matched' then 'ready'
    else document.processing_status
  end,
  submitted_at = coalesce(document.submitted_at, document.created_at)
where document.document_type = 'receipt';

alter table public.timefit_user_finance_documents
  alter column processing_status set default 'uploaded',
  add constraint timefit_user_finance_documents_processing_status_check
    check (processing_status in ('uploaded','queued','processing','ready','failed')),
  add constraint timefit_user_finance_documents_payment_method_check
    check (payment_method is null or payment_method in ('corporate_card','personal_card','cash','bank_transfer','other')),
  add constraint timefit_user_finance_documents_review_status_check
    check (review_status in ('draft','submitted','submitter_review','manager_review','change_requested','resubmitted','approved','rejected','withdrawn')),
  add constraint timefit_user_finance_documents_page_count_check check (page_count between 1 and 20);

create index if not exists timefit_finance_documents_review_queue_idx
  on public.timefit_user_finance_documents(organization_id, review_status, created_at desc)
  where document_type = 'receipt';
create index if not exists timefit_finance_documents_cost_center_idx
  on public.timefit_user_finance_documents(organization_id, cost_center_id, document_date desc)
  where document_type = 'receipt';
create index if not exists timefit_finance_documents_duplicate_idx
  on public.timefit_user_finance_documents(duplicate_of_document_id)
  where duplicate_of_document_id is not null;

create table if not exists public.timefit_user_finance_document_pages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  document_id uuid not null references public.timefit_user_finance_documents(id) on delete cascade,
  page_number integer not null check (page_number between 1 and 20),
  storage_path text not null unique,
  mime_type text,
  file_size bigint not null default 0 check (file_size >= 0),
  content_sha256 text,
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  quality_result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (document_id, page_number)
);
create index if not exists timefit_finance_document_pages_document_idx
  on public.timefit_user_finance_document_pages(document_id, page_number);

insert into public.timefit_user_finance_document_pages(
  organization_id, document_id, page_number, storage_path, mime_type, file_size, content_sha256, created_at
)
select organization_id, id, 1, storage_path, mime_type, file_size, content_sha256, created_at
from public.timefit_user_finance_documents document
where document.document_type = 'receipt'
  and not exists (
    select 1 from public.timefit_user_finance_document_pages page where page.document_id = document.id
  )
on conflict (storage_path) do nothing;

alter table public.timefit_user_cost_centers enable row level security;
alter table public.timefit_user_finance_document_pages enable row level security;

create policy "organization members read active cost centers"
  on public.timefit_user_cost_centers for select
  using (public.timefit_user_is_member(organization_id));
create policy "owner or settings manager creates cost centers"
  on public.timefit_user_cost_centers for insert
  with check (
    public.timefit_user_is_organization_owner(organization_id)
    or public.timefit_user_has_management_permission(organization_id,'settings.manage')
  );
create policy "owner or settings manager updates cost centers"
  on public.timefit_user_cost_centers for update
  using (
    public.timefit_user_is_organization_owner(organization_id)
    or public.timefit_user_has_management_permission(organization_id,'settings.manage')
  )
  with check (
    public.timefit_user_is_organization_owner(organization_id)
    or public.timefit_user_has_management_permission(organization_id,'settings.manage')
  );

create policy "manager reads finance document pages"
  on public.timefit_user_finance_document_pages for select
  using (
    public.timefit_user_is_organization_owner(organization_id)
    or public.timefit_user_has_management_permission(organization_id,'finance.view')
    or public.timefit_user_has_management_permission(organization_id,'expense.manage')
  );
create policy "staff reads own finance document pages"
  on public.timefit_user_finance_document_pages for select
  using (exists (
    select 1 from public.timefit_user_finance_documents document
    where document.id = document_id and document.uploaded_by = auth.uid()
  ));
create policy "staff inserts own finance document pages"
  on public.timefit_user_finance_document_pages for insert
  with check (exists (
    select 1 from public.timefit_user_finance_documents document
    where document.id = document_id
      and document.organization_id = organization_id
      and document.uploaded_by = auth.uid()
  ));
create policy "staff deletes own unprocessed receipt documents"
  on public.timefit_user_finance_documents for delete
  using (
    document_type='receipt' and uploaded_by=auth.uid()
    and processing_status='uploaded'
  );
create policy "staff deletes own receipt files"
  on storage.objects for delete
  using (
    bucket_id='timefit-finance-documents'
    and public.timefit_user_is_member((storage.foldername(name))[1]::uuid)
    and (storage.foldername(name))[2]=auth.uid()::text
  );

grant select on public.timefit_user_cost_centers to authenticated;
grant select,insert,delete on public.timefit_user_finance_document_pages to authenticated;
grant delete on public.timefit_user_finance_documents to authenticated;
grant all on public.timefit_user_cost_centers,public.timefit_user_finance_document_pages to service_role;

select pg_notify('pgrst','reload schema');
