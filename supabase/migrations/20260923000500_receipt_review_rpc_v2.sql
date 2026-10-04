-- Keep the legacy card-match RPC compatible with the receipt-v2 processing and
-- review state machines. Processing describes OCR; review_status describes work.

create or replace function public.timefit_user_review_expense_match(
  p_match_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match public.timefit_user_expense_matches;
  v_review_status text;
begin
  if p_action not in ('confirm','reject','unlink') then raise exception 'review_action_invalid'; end if;

  select * into v_match from public.timefit_user_expense_matches where id = p_match_id for update;
  if v_match.id is null then raise exception 'match_not_found'; end if;
  if not (
    public.timefit_user_is_organization_owner(v_match.organization_id)
    or public.timefit_user_has_management_permission(v_match.organization_id,'expense.receipt.review')
    or public.timefit_user_has_management_permission(v_match.organization_id,'expense.manage')
  ) then raise exception 'forbidden'; end if;

  if p_action = 'confirm' then
    if v_match.expense_id is null or v_match.transaction_group_id is null then raise exception 'match_incomplete'; end if;
    insert into public.timefit_user_expense_sources(
      organization_id, expense_id, source_type, source_id, is_primary, match_reason
    ) values (
      v_match.organization_id, v_match.expense_id, 'card_transaction_group',
      v_match.transaction_group_id::text, false,
      jsonb_build_object('matchId',v_match.id,'score',v_match.score,'confirmedBy',auth.uid())
    ) on conflict (organization_id, source_type, source_id) do update
      set expense_id = excluded.expense_id, match_reason = excluded.match_reason
      where public.timefit_user_expense_sources.expense_id = excluded.expense_id;

    if not exists (
      select 1 from public.timefit_user_expense_sources
      where organization_id = v_match.organization_id
        and source_type = 'card_transaction_group'
        and source_id = v_match.transaction_group_id::text
        and expense_id = v_match.expense_id
    ) then raise exception 'card_transaction_already_linked'; end if;

    update public.timefit_user_expense_matches set status='confirmed', decided_by=auth.uid(), decided_at=now() where id=v_match.id;
    update public.timefit_user_expense_matches set status='rejected', decided_by=auth.uid(), decided_at=now()
      where document_id=v_match.document_id and id<>v_match.id and status='suggested';
    update public.timefit_user_expenses set status='confirmed', confirmed_by=auth.uid(), confirmed_at=now(), updated_at=now() where id=v_match.expense_id;
    update public.timefit_user_card_transaction_groups set reconciliation_status='matched', updated_at=now() where id=v_match.transaction_group_id;
    v_review_status := 'approved';
  elsif p_action = 'reject' then
    if v_match.status = 'confirmed' then raise exception 'confirmed_match_requires_unlink'; end if;
    update public.timefit_user_expense_matches set status='rejected', decided_by=auth.uid(), decided_at=now() where id=v_match.id;
    v_review_status := 'manager_review';
  else
    if v_match.status <> 'confirmed' then raise exception 'confirmed_match_not_found'; end if;
    delete from public.timefit_user_expense_sources
      where organization_id=v_match.organization_id and expense_id=v_match.expense_id
        and source_type='card_transaction_group' and source_id=v_match.transaction_group_id::text;
    update public.timefit_user_expense_matches set status='unlinked', decided_by=auth.uid(), decided_at=now() where id=v_match.id;
    update public.timefit_user_expenses set status='review_required', confirmed_by=null, confirmed_at=null, updated_at=now() where id=v_match.expense_id;
    update public.timefit_user_card_transaction_groups set reconciliation_status='unreviewed', updated_at=now() where id=v_match.transaction_group_id;
    v_review_status := 'manager_review';
  end if;

  if v_match.document_id is not null then
    update public.timefit_user_finance_documents
      set processing_status='ready', review_status=v_review_status,
          reviewed_by=case when v_review_status='approved' then auth.uid() else null end,
          reviewed_at=case when v_review_status='approved' then now() else null end,
          change_request_reason=null
      where id=v_match.document_id;
  end if;
  insert into public.timefit_user_expense_audit_logs(
    organization_id,entity_type,entity_id,action,before_value,after_value,actor_id,source
  ) values (
    v_match.organization_id,'expense_match',v_match.id,'match_'||p_action,
    jsonb_build_object('status',v_match.status),
    jsonb_build_object('status',case when p_action='confirm' then 'confirmed' when p_action='reject' then 'rejected' else 'unlinked' end),
    auth.uid(),'user'
  );
  return jsonb_build_object('matchId',v_match.id,'expenseId',v_match.expense_id,'action',p_action,'documentStatus','ready','reviewStatus',v_review_status);
end $$;

revoke all on function public.timefit_user_review_expense_match(uuid,text) from public;
grant execute on function public.timefit_user_review_expense_match(uuid,text) to authenticated;

create or replace function public.timefit_user_review_receipt(
  p_document_id uuid,
  p_action text,
  p_reason text default null,
  p_expense_id uuid default null
)
returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  v_document public.timefit_user_finance_documents;
  v_expense public.timefit_user_expenses;
  v_now timestamptz := now();
begin
  if p_action not in ('request_change','approve_receipt') then raise exception 'receipt_review_action_invalid'; end if;
  select * into v_document from public.timefit_user_finance_documents
    where id=p_document_id and document_type='receipt' for update;
  if v_document.id is null then raise exception 'receipt_document_not_found'; end if;
  if not public.timefit_user_can_review_receipt(v_document.organization_id,v_document.cost_center_id)
    and not (
      public.timefit_user_is_organization_owner(v_document.organization_id)
      or public.timefit_user_has_management_permission(v_document.organization_id,'expense.manage')
    ) then raise exception 'forbidden'; end if;

  if p_action='request_change' then
    if length(trim(coalesce(p_reason,''))) not between 2 and 500 then raise exception 'receipt_change_reason_invalid'; end if;
    update public.timefit_user_finance_documents set
      review_status='change_requested',change_request_reason=trim(p_reason),change_requested_at=v_now,
      reviewed_by=auth.uid(),reviewed_at=v_now
      where id=v_document.id;
  else
    select * into v_expense from public.timefit_user_expenses
      where id=p_expense_id and organization_id=v_document.organization_id for update;
    if v_expense.id is null then raise exception 'expense_not_found'; end if;
    update public.timefit_user_expenses set status='confirmed',confirmed_by=auth.uid(),confirmed_at=v_now,updated_at=v_now where id=v_expense.id;
    update public.timefit_user_finance_documents set
      processing_status='ready',review_status='approved',change_request_reason=null,
      reviewed_by=auth.uid(),reviewed_at=v_now
      where id=v_document.id;
  end if;

  insert into public.timefit_user_expense_audit_logs(
    organization_id,entity_type,entity_id,action,before_value,after_value,actor_id,source
  ) values (
    v_document.organization_id,'finance_document',v_document.id,'receipt_'||p_action,
    jsonb_build_object('reviewStatus',v_document.review_status),
    jsonb_build_object('reviewStatus',case when p_action='request_change' then 'change_requested' else 'approved' end,'reason',p_reason,'expenseId',p_expense_id),
    auth.uid(),'user'
  );
  return jsonb_build_object('documentId',v_document.id,'expenseId',p_expense_id,'action',p_action,'reviewStatus',case when p_action='request_change' then 'change_requested' else 'approved' end);
end $$;

revoke all on function public.timefit_user_review_receipt(uuid,text,text,uuid) from public;
grant execute on function public.timefit_user_review_receipt(uuid,text,text,uuid) to authenticated;
select pg_notify('pgrst','reload schema');
