-- Structured OCR history, line items and cost-center allocations.

alter table public.timefit_user_expense_processing_runs
  add column if not exists attempt_count integer not null default 0,
  add column if not exists claimed_at timestamptz,
  add column if not exists heartbeat_at timestamptz;
alter table public.timefit_user_expense_processing_runs
  drop constraint if exists timefit_user_expense_processing_runs_attempt_count_check;
alter table public.timefit_user_expense_processing_runs
  add constraint timefit_user_expense_processing_runs_attempt_count_check check (attempt_count between 0 and 5);

create unique index if not exists timefit_expense_processing_one_active_run
  on public.timefit_user_expense_processing_runs(document_id)
  where status in ('queued','processing');

create table if not exists public.timefit_user_receipt_extractions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  document_id uuid not null references public.timefit_user_finance_documents(id) on delete cascade,
  processing_run_id uuid not null references public.timefit_user_expense_processing_runs(id) on delete restrict,
  raw_text text not null,
  normalized_header jsonb not null default '{}'::jsonb,
  field_confidence jsonb not null default '{}'::jsonb,
  validation_result jsonb not null default '{}'::jsonb,
  provider text not null,
  model text,
  extractor_version text not null,
  created_at timestamptz not null default now(),
  unique (processing_run_id)
);
create index if not exists timefit_receipt_extractions_document_idx
  on public.timefit_user_receipt_extractions(document_id, created_at desc);

create table if not exists public.timefit_user_receipt_line_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  document_id uuid not null references public.timefit_user_finance_documents(id) on delete cascade,
  expense_id uuid references public.timefit_user_expenses(id) on delete set null,
  extraction_id uuid not null references public.timefit_user_receipt_extractions(id) on delete cascade,
  line_number integer not null check (line_number between 1 and 200),
  raw_text text not null default '',
  item_name_raw text,
  item_name_normalized text,
  quantity numeric(14,4) check (quantity is null or quantity >= 0),
  unit text,
  unit_price bigint check (unit_price is null or unit_price >= 0),
  discount_amount bigint not null default 0 check (discount_amount >= 0),
  line_amount bigint check (line_amount is null or line_amount >= 0),
  tax_type text not null default 'unknown' check (tax_type in ('taxable','tax_free','unknown')),
  expense_category text,
  cost_center_id uuid references public.timefit_user_cost_centers(id) on delete set null,
  confidence numeric(5,4) check (confidence is null or confidence between 0 and 1),
  corrected_by uuid references auth.users(id) on delete set null,
  corrected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (extraction_id, line_number)
);
create index if not exists timefit_receipt_line_items_document_idx
  on public.timefit_user_receipt_line_items(document_id, line_number);
create index if not exists timefit_receipt_line_items_analytics_idx
  on public.timefit_user_receipt_line_items(organization_id, cost_center_id, item_name_normalized)
  where line_amount is not null;

create table if not exists public.timefit_user_expense_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.timefit_user_organizations(id) on delete cascade,
  expense_id uuid not null references public.timefit_user_expenses(id) on delete cascade,
  cost_center_id uuid not null references public.timefit_user_cost_centers(id) on delete restrict,
  allocation_amount bigint not null check (allocation_amount >= 0),
  allocation_rate numeric(7,6) check (allocation_rate is null or allocation_rate between 0 and 1),
  allocation_method text not null check (allocation_method in ('direct','item','manual_rate','sales_rate')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (expense_id, cost_center_id)
);
create index if not exists timefit_expense_allocations_center_idx
  on public.timefit_user_expense_allocations(organization_id, cost_center_id, expense_id);

create or replace function public.timefit_user_claim_receipt_processing_run(p_run_id uuid)
returns public.timefit_user_expense_processing_runs
language plpgsql security definer set search_path=public as $$
declare v_run public.timefit_user_expense_processing_runs;
begin
  update public.timefit_user_expense_processing_runs
  set status='processing', claimed_at=now(), heartbeat_at=now(), started_at=coalesce(started_at,now()),
      attempt_count=attempt_count+1
  where id=p_run_id and status='queued' and attempt_count < 5
  returning * into v_run;
  if v_run.id is null then raise exception 'receipt_run_not_claimable'; end if;
  return v_run;
end $$;

create or replace function public.timefit_user_replace_expense_allocations(
  p_expense_id uuid,
  p_allocations jsonb
)
returns setof public.timefit_user_expense_allocations
language plpgsql security definer set search_path=public as $$
declare
  v_expense public.timefit_user_expenses;
  v_total bigint;
begin
  select * into v_expense from public.timefit_user_expenses where id=p_expense_id for update;
  if v_expense.id is null then raise exception 'expense_not_found'; end if;
  if not (
    public.timefit_user_is_organization_owner(v_expense.organization_id)
    or public.timefit_user_has_management_permission(v_expense.organization_id,'expense.manage')
  ) then raise exception 'forbidden'; end if;
  if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'expense_allocations_required';
  end if;
  select coalesce(sum((row->>'allocationAmount')::bigint),0) into v_total
  from jsonb_array_elements(p_allocations) row;
  if v_total <> v_expense.total_amount then raise exception 'expense_allocation_total_mismatch'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_allocations) row
    left join public.timefit_user_cost_centers center
      on center.id=(row->>'costCenterId')::uuid
      and center.organization_id=v_expense.organization_id and center.status='active'
    where center.id is null or (row->>'allocationAmount')::bigint < 0
  ) then raise exception 'expense_allocation_invalid'; end if;

  delete from public.timefit_user_expense_allocations where expense_id=v_expense.id;
  insert into public.timefit_user_expense_allocations(
    organization_id,expense_id,cost_center_id,allocation_amount,allocation_rate,allocation_method,created_by
  )
  select v_expense.organization_id,v_expense.id,(row->>'costCenterId')::uuid,
    (row->>'allocationAmount')::bigint,
    nullif(row->>'allocationRate','')::numeric,
    coalesce(nullif(row->>'allocationMethod',''),'direct'),auth.uid()
  from jsonb_array_elements(p_allocations) row;

  insert into public.timefit_user_expense_audit_logs(
    organization_id,entity_type,entity_id,action,after_value,actor_id,source
  ) values (
    v_expense.organization_id,'expense',v_expense.id,'allocations_replaced',p_allocations,auth.uid(),'user'
  );
  return query select * from public.timefit_user_expense_allocations where expense_id=v_expense.id order by created_at;
end $$;

alter table public.timefit_user_receipt_extractions enable row level security;
alter table public.timefit_user_receipt_line_items enable row level security;
alter table public.timefit_user_expense_allocations enable row level security;

create policy "manager reads receipt extractions" on public.timefit_user_receipt_extractions for select
using (
  public.timefit_user_is_organization_owner(organization_id)
  or public.timefit_user_has_management_permission(organization_id,'finance.view')
  or public.timefit_user_has_management_permission(organization_id,'expense.manage')
);
create policy "staff reads own receipt extractions" on public.timefit_user_receipt_extractions for select
using (exists(select 1 from public.timefit_user_finance_documents document where document.id=document_id and document.uploaded_by=auth.uid()));
create policy "manager reads receipt line items" on public.timefit_user_receipt_line_items for select
using (
  public.timefit_user_is_organization_owner(organization_id)
  or public.timefit_user_has_management_permission(organization_id,'finance.view')
  or public.timefit_user_has_management_permission(organization_id,'expense.manage')
);
create policy "staff reads own receipt line items" on public.timefit_user_receipt_line_items for select
using (exists(select 1 from public.timefit_user_finance_documents document where document.id=document_id and document.uploaded_by=auth.uid()));
create policy "manager reads expense allocations" on public.timefit_user_expense_allocations for select
using (
  public.timefit_user_is_organization_owner(organization_id)
  or public.timefit_user_has_management_permission(organization_id,'finance.view')
  or public.timefit_user_has_management_permission(organization_id,'expense.manage')
);

grant select on public.timefit_user_receipt_extractions,public.timefit_user_receipt_line_items,public.timefit_user_expense_allocations to authenticated;
grant execute on function public.timefit_user_replace_expense_allocations(uuid,jsonb) to authenticated;
grant all on public.timefit_user_receipt_extractions,public.timefit_user_receipt_line_items,public.timefit_user_expense_allocations to service_role;
grant execute on function public.timefit_user_claim_receipt_processing_run(uuid) to service_role;

select pg_notify('pgrst','reload schema');
