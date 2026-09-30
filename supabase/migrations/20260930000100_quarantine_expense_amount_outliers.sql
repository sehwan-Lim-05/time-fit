-- Keep implausible OCR totals out of confirmed settlement while preserving the
-- original expense, receipt source and audit trail for manager correction.
do $$
declare
  target record;
begin
  for target in
    select * from public.timefit_user_expenses
    where organization_id = '7df7b797-2e2a-4e99-b3e4-ef88c443ff31'::uuid
      and status = 'confirmed'
      and total_amount > 1000000000
  loop
    insert into public.timefit_user_expense_audit_logs(
      organization_id, entity_type, entity_id, action, before_value, after_value, actor_id, source
    ) values (
      target.organization_id, 'expense', target.id, 'amount_outlier_quarantined',
      jsonb_build_object('status', target.status, 'totalAmount', target.total_amount, 'confirmedAt', target.confirmed_at),
      jsonb_build_object('status', 'review_required', 'reason', 'single_expense_amount_over_1000000000'),
      null, 'system'
    );

    update public.timefit_user_expenses set
      status = 'review_required', confirmed_by = null, confirmed_at = null, updated_at = now()
    where id = target.id;

    update public.timefit_user_expense_matches set
      status = 'unlinked', decided_at = now()
    where expense_id = target.id and status = 'confirmed';

    update public.timefit_user_finance_documents set
      review_status = 'manager_review', reviewed_by = null, reviewed_at = null
    where id in (
      select source_id::uuid from public.timefit_user_expense_sources
      where expense_id = target.id and source_type = 'receipt'
        and source_id ~ '^[0-9a-fA-F-]{36}$'
    );
  end loop;
end $$;

alter table public.timefit_user_expenses
  drop constraint if exists timefit_expenses_single_amount_guard;
alter table public.timefit_user_expenses
  add constraint timefit_expenses_single_amount_guard
  check (total_amount between 0 and 1000000000) not valid;

comment on constraint timefit_expenses_single_amount_guard on public.timefit_user_expenses
  is 'Prevents OCR or manual-entry outliers above KRW 1 billion per expense.';
