import { authorizeFinance, canAccessFinanceCostCenter, financeError, financeRest, financeServerConfigured, methodNotAllowed, serviceHeaders } from './_finance-server.js';
import { recoverStaleReceiptRuns } from './receipt-process.js';
import { expenseAmountError } from '../domain/expense-amount-validation.js';

async function userRpc(token, name, body) {
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { ...serviceHeaders(), Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || `review_${response.status}`);
  return payload;
}

export function eligibleBulkMatches(matches = []) {
  const bestByDocument = new Map();
  for (const match of matches) {
    if (match.status !== 'suggested' || Number(match.score) < 95 || !match.document_id || !match.transaction_group_id || !match.expense_id) continue;
    const current = bestByDocument.get(match.document_id);
    if (!current || Number(match.score) > Number(current.score)) bestByDocument.set(match.document_id, match);
  }
  return [...bestByDocument.values()];
}

export default async function handler(req, res) {
  if (!['GET','POST','PATCH'].includes(req.method)) return methodNotAllowed(res);
  if (!financeServerConfigured()) return res.status(503).json({ ok: false, error: '금융 처리 서버 설정이 필요합니다.' });
  const organizationId = req.method === 'GET' ? req.query?.organizationId : req.body?.organizationId;
  const auth = await authorizeFinance(req, organizationId, { permissionsAny: req.method === 'GET' ? ['expense.receipt.review','expense.manage','finance.view'] : ['expense.receipt.review','expense.manage'] });
  if (!auth) return res.status(req.headers.authorization ? 403 : 401).json({ ok: false, error: '관리자 인증이 필요합니다.' });

  try {
    if (req.method === 'GET') {
      await recoverStaleReceiptRuns(organizationId);
      const requestedStatus = req.query?.status;
      const allowedReviews = ['submitted','submitter_review','manager_review','change_requested','approved','rejected','withdrawn'];
      const statusFilter = requestedStatus === 'attention' || !requestedStatus
        ? 'or=(processing_status.in.(uploaded,queued,processing,failed),review_status.in.(submitted,submitter_review,manager_review,change_requested,resubmitted))'
        : requestedStatus === 'failed' ? 'processing_status=eq.failed'
          : requestedStatus === 'processing' ? 'processing_status=in.(uploaded,queued,processing)'
          : `review_status=eq.${encodeURIComponent(allowedReviews.includes(requestedStatus) ? requestedStatus : 'manager_review')}`;
      const costCenterFilter = req.query?.costCenterId ? `&cost_center_id=eq.${encodeURIComponent(req.query.costCenterId)}` : '';
      const allDocuments = await financeRest(`timefit_user_finance_documents?organization_id=eq.${encodeURIComponent(organizationId)}&document_type=eq.receipt&${statusFilter}${costCenterFilter}&select=id,title,file_name,storage_path,mime_type,document_date,processing_status,review_status,cost_center_id,payment_method,change_request_reason,extracted_data,processing_error,processed_at,created_at&order=created_at.desc&limit=100`);
      const documents = [];
      for (const document of allDocuments) if (await canAccessFinanceCostCenter(auth, organizationId, document.cost_center_id)) documents.push(document);
      const documentIds = documents.map(item => item.id);
      const matches = documentIds.length ? await financeRest(`timefit_user_expense_matches?organization_id=eq.${encodeURIComponent(organizationId)}&document_id=in.(${documentIds.map(encodeURIComponent).join(',')})&select=*,expense:timefit_user_expenses(*),transaction:timefit_user_card_transaction_groups(*,card:timefit_user_corporate_cards(issuer,nickname,last4))&order=score.desc`) : [];
      const sources = documentIds.length ? await financeRest(`timefit_user_expense_sources?organization_id=eq.${encodeURIComponent(organizationId)}&source_type=eq.receipt&source_id=in.(${documentIds.map(encodeURIComponent).join(',')})&select=source_id,expense:timefit_user_expenses(*)`) : [];
      const lines = documentIds.length ? await financeRest(`timefit_user_receipt_line_items?document_id=in.(${documentIds.map(encodeURIComponent).join(',')})&select=id,document_id,line_number,item_name_raw,item_name_normalized,quantity,unit,unit_price,discount_amount,line_amount,tax_type,confidence&order=line_number.asc`) : [];
      return res.status(200).json({ ok: true, documents: documents.map(document => ({ ...document, expense: sources.find(source => source.source_id === document.id)?.expense || null, matches: matches.filter(match => match.document_id === document.id), lineItems: lines.filter(line => line.document_id === document.id) })) });
    }

    if (req.method === 'PATCH') {
      const { expenseId, transactionDate, totalAmount, merchantName, merchantBusinessNumber, category, reason, rememberRule } = req.body || {};
      const amount = Number(totalAmount);
      if (!expenseId || !transactionDate || !Number.isFinite(amount) || amount < 0) return res.status(400).json({ ok: false, error: '거래일과 총금액을 확인해 주세요.' });
      if (expenseAmountError(amount)) return res.status(400).json({ ok: false, code: 'expense_amount_outlier', error: expenseAmountError(amount) });
      const rows = await financeRest(`timefit_user_expenses?id=eq.${encodeURIComponent(expenseId)}&organization_id=eq.${encodeURIComponent(organizationId)}&select=id,status`);
      if (!rows.length) return res.status(404).json({ ok: false, error: '지출 초안을 찾을 수 없습니다.' });
      if (rows[0].status === 'excluded') return res.status(409).json({ ok: false, error: '제외된 지출은 수정할 수 없습니다.' });
      const updated = await financeRest(`timefit_user_expenses?id=eq.${encodeURIComponent(expenseId)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ transaction_date: transactionDate, total_amount: amount, merchant_name: merchantName || null, merchant_business_number: merchantBusinessNumber || null, category: category || null, reason: reason || null, updated_at: new Date().toISOString() }) });
      let rule = null;
      if (rememberRule && category && (merchantBusinessNumber || merchantName)) {
        const matchType = merchantBusinessNumber ? 'merchant_business_number' : 'merchant_name';
        const matchValue = String(merchantBusinessNumber || merchantName).toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
        const rules = await financeRest('timefit_user_expense_classification_rules?on_conflict=organization_id,match_type,match_value', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify([{ organization_id: organizationId, match_type: matchType, match_value: matchValue, category, default_reason: reason || null, is_active: true, created_by: auth.user.id, updated_at: new Date().toISOString() }]) });
        rule = rules[0];
      }
      return res.status(200).json({ ok: true, expense: updated[0], rule });
    }

    const action = String(req.body?.action || '');
    if (['request_change','approve_receipt'].includes(action)) {
      const documentId = String(req.body?.documentId || '');
      const rows = await financeRest(`timefit_user_finance_documents?id=eq.${encodeURIComponent(documentId)}&organization_id=eq.${encodeURIComponent(organizationId)}&document_type=eq.receipt&select=id,cost_center_id,review_status`);
      const document = rows[0];
      if (!document || !await canAccessFinanceCostCenter(auth, organizationId, document.cost_center_id)) return res.status(404).json({ ok: false, error: '검토할 영수증을 찾을 수 없습니다.' });
      if (action === 'request_change') {
        const reason = String(req.body?.reason || '').trim();
        if (reason.length < 2 || reason.length > 500) return res.status(400).json({ ok: false, error: '수정이 필요한 내용을 2~500자로 입력해 주세요.' });
        const result = await userRpc(auth.token, 'timefit_user_review_receipt', { p_document_id: documentId, p_action: action, p_reason: reason, p_expense_id: null });
        return res.status(200).json({ ok: true, result });
      }
      const expenseId = String(req.body?.expenseId || '');
      const expenses = await financeRest(`timefit_user_expenses?id=eq.${encodeURIComponent(expenseId)}&organization_id=eq.${encodeURIComponent(organizationId)}&select=id,total_amount,status&limit=1`);
      if (!expenses[0]) return res.status(404).json({ ok: false, error: '확정할 지출을 찾을 수 없습니다.' });
      if (expenseAmountError(expenses[0].total_amount)) return res.status(409).json({ ok: false, code: 'expense_amount_outlier', error: expenseAmountError(expenses[0].total_amount) });
      const result = await userRpc(auth.token, 'timefit_user_review_receipt', { p_document_id: documentId, p_action: action, p_reason: null, p_expense_id: expenseId });
      return res.status(200).json({ ok: true, result });
    }
    if (action === 'bulk_confirm') {
      const requestedIds = [...new Set(Array.isArray(req.body?.matchIds) ? req.body.matchIds.filter(Boolean).slice(0, 50) : [])];
      if (!requestedIds.length) return res.status(400).json({ ok: false, error: '일괄 확정할 항목을 선택해 주세요.' });
      const matches = await financeRest(`timefit_user_expense_matches?organization_id=eq.${encodeURIComponent(organizationId)}&id=in.(${requestedIds.map(encodeURIComponent).join(',')})&select=id,document_id,expense_id,transaction_group_id,status,score`);
      const documentIds = [...new Set(matches.map(match => match.document_id).filter(Boolean))];
      const allCandidates = documentIds.length ? await financeRest(`timefit_user_expense_matches?organization_id=eq.${encodeURIComponent(organizationId)}&document_id=in.(${documentIds.map(encodeURIComponent).join(',')})&status=eq.suggested&select=id,document_id,expense_id,transaction_group_id,status,score`) : [];
      const requestedSet = new Set(requestedIds); const eligible = eligibleBulkMatches(allCandidates).filter(match => requestedSet.has(match.id)); const results = [];
      for (const match of eligible) {
        try { await userRpc(auth.token, 'timefit_user_review_expense_match', { p_match_id: match.id, p_action: 'confirm' }); results.push({ matchId: match.id, status: 'confirmed' }); }
        catch (error) { results.push({ matchId: match.id, status: 'failed', error: String(error.message || 'confirm_failed').slice(0, 120) }); }
      }
      return res.status(200).json({ ok: true, requested: requestedIds.length, eligible: eligible.length, confirmed: results.filter(item => item.status === 'confirmed').length, failed: results.filter(item => item.status === 'failed').length, results });
    }
    if (['confirm','reject','unlink'].includes(action)) {
      const result = await userRpc(auth.token, 'timefit_user_review_expense_match', { p_match_id: req.body?.matchId, p_action: action });
      return res.status(200).json({ ok: true, result });
    }
    if (action === 'exclude') {
      const { expenseId } = req.body || {};
      const rows = await financeRest(`timefit_user_expenses?id=eq.${encodeURIComponent(expenseId)}&organization_id=eq.${encodeURIComponent(organizationId)}&status=neq.confirmed&select=id`);
      if (!rows.length) return res.status(409).json({ ok: false, error: '확정 지출은 연결을 해제한 뒤 제외해 주세요.' });
      await financeRest(`timefit_user_expenses?id=eq.${encodeURIComponent(expenseId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'excluded', updated_at: new Date().toISOString() }) });
      return res.status(200).json({ ok: true, result: { expenseId, action: 'exclude' } });
    }
    return res.status(400).json({ ok: false, error: '검토 작업을 확인해 주세요.' });
  } catch (error) {
    const duplicate = /card_transaction_already_linked|duplicate key|unique constraint/i.test(String(error.message || ''));
    if (duplicate) return res.status(409).json({ ok: false, code: 'card_transaction_already_linked', error: '이 카드 거래는 이미 다른 지출에 연결되어 있습니다.' });
    return financeError(res, error, '지출 증빙 검토를 완료하지 못했습니다.');
  }
}
