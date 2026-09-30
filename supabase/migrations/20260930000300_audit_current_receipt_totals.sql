-- Deployment-time read-only audit for the Butter Villa receipt evidence total.
do $$
declare
  item record;
begin
  raise notice 'receipt_audit_start';
  for item in
    select
      document.id as document_id,
      document.title,
      document.document_date,
      document.processing_status,
      document.review_status,
      document.extracted_data ->> 'merchantName' as extracted_merchant,
      document.extracted_data ->> 'totalAmount' as extracted_total,
      expense.id as expense_id,
      expense.status as expense_status,
      expense.total_amount as expense_total,
      coalesce(lines.line_count, 0) as line_count,
      coalesce(lines.line_total, 0) as line_total
    from public.timefit_user_finance_documents document
    left join public.timefit_user_expense_sources source
      on source.organization_id = document.organization_id
      and source.source_type = 'receipt'
      and source.source_id = document.id::text
    left join public.timefit_user_expenses expense on expense.id = source.expense_id
    left join lateral (
      select count(*) as line_count, coalesce(sum(line_amount), 0) as line_total
      from public.timefit_user_receipt_line_items
      where document_id = document.id
    ) lines on true
    where document.organization_id = '7df7b797-2e2a-4e99-b3e4-ef88c443ff31'::uuid
      and document.document_type = 'receipt'
      and document.review_status not in ('rejected', 'withdrawn')
    order by document.created_at desc
  loop
    raise notice 'receipt_audit=%', jsonb_build_object(
      'documentId', item.document_id,
      'title', item.title,
      'documentDate', item.document_date,
      'processingStatus', item.processing_status,
      'reviewStatus', item.review_status,
      'merchant', item.extracted_merchant,
      'ocrTotal', item.extracted_total,
      'expenseId', item.expense_id,
      'expenseStatus', item.expense_status,
      'expenseTotal', item.expense_total,
      'lineCount', item.line_count,
      'lineTotal', item.line_total
    );
  end loop;
  raise notice 'receipt_audit_end';
end $$;
