do $$
declare
  target_document uuid := '63ae86c0-d16e-4d76-b087-ea89cac38aa4'::uuid;
  target_expense uuid := 'c8d14065-3fdd-468a-8932-535abd55563e'::uuid;
  verified_line_total bigint;
  verified_line_count integer;
  before_expense jsonb;
begin
  select count(*), coalesce(sum(line_amount), 0) into verified_line_count, verified_line_total
  from public.timefit_user_receipt_line_items where document_id = target_document;

  if verified_line_count <> 10 or verified_line_total <> 153195 then
    raise exception 'Gfresh receipt evidence changed: count %, total %', verified_line_count, verified_line_total;
  end if;

  select to_jsonb(expense) into before_expense from public.timefit_user_expenses expense
  where id = target_expense and organization_id = '7df7b797-2e2a-4e99-b3e4-ef88c443ff31'::uuid and status = 'review_required';
  if before_expense is null then raise exception 'Gfresh review expense not found'; end if;

  update public.timefit_user_expenses set total_amount = verified_line_total, supply_amount = null, vat_amount = null,
    category = '재료비', updated_at = now() where id = target_expense;
  update public.timefit_user_expense_allocations set allocation_amount = verified_line_total, updated_at = now()
    where expense_id = target_expense;
  update public.timefit_user_finance_documents set extracted_data = jsonb_set(jsonb_set(jsonb_set(coalesce(extracted_data, '{}'::jsonb), '{totalAmount}', to_jsonb(verified_line_total)), '{category}', to_jsonb('재료비'::text)), '{categorySource}', to_jsonb('verified_line_item_sum'::text))
    where id = target_document;
  update public.timefit_user_receipt_extractions set normalized_header = jsonb_set(jsonb_set(jsonb_set(coalesce(normalized_header, '{}'::jsonb), '{totalAmount}', to_jsonb(verified_line_total)), '{category}', to_jsonb('재료비'::text)), '{categorySource}', to_jsonb('verified_line_item_sum'::text))
    where document_id = target_document;

  insert into public.timefit_user_expense_classification_rules (organization_id, match_type, match_value, category, priority, is_active)
  values ('7df7b797-2e2a-4e99-b3e4-ef88c443ff31'::uuid, 'merchant_name', '주식회사지프레시', '재료비', 100, true)
  on conflict (organization_id, match_type, match_value) do update set category = excluded.category, is_active = true, updated_at = now();

  insert into public.timefit_user_expense_audit_logs (organization_id, entity_type, entity_id, action, before_value, after_value, actor_id, source)
  values ('7df7b797-2e2a-4e99-b3e4-ef88c443ff31'::uuid, 'expense', target_expense, 'receipt_line_total_corrected', before_expense,
    (select to_jsonb(expense) from public.timefit_user_expenses expense where id = target_expense), null, 'system');
end $$;
