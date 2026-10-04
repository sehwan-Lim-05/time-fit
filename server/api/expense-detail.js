import { authorizeFinance, financeError, financeRest, financeServerConfigured, methodNotAllowed } from './_finance-server.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  if (!financeServerConfigured()) return res.status(503).json({ ok: false, error: '금융 처리 서버 설정이 필요합니다.' });
  const { organizationId, expenseId } = req.query || {};
  const auth = await authorizeFinance(req, organizationId);
  if (!auth) return res.status(req.headers.authorization ? 403 : 401).json({ ok: false, error: '관리자 인증이 필요합니다.' });
  if (!expenseId) return res.status(400).json({ ok: false, error: '지출 항목을 선택해 주세요.' });
  try {
    const expenses = await financeRest(`timefit_user_expenses?id=eq.${encodeURIComponent(expenseId)}&organization_id=eq.${encodeURIComponent(organizationId)}&select=*,staff:timefit_user_staff(display_name,department,job_title)&limit=1`);
    if (!expenses.length) return res.status(404).json({ ok: false, error: '지출 원장 항목을 찾을 수 없습니다.' });
    const sources = await financeRest(`timefit_user_expense_sources?expense_id=eq.${encodeURIComponent(expenseId)}&organization_id=eq.${encodeURIComponent(organizationId)}&select=id,source_type,source_id,is_primary,match_reason,created_at&order=is_primary.desc,created_at.asc`);
    const receiptIds = sources.filter(item => item.source_type === 'receipt').map(item => item.source_id);
    const cardIds = sources.filter(item => item.source_type === 'card_transaction_group').map(item => item.source_id);
    const [documents, transactions, audits] = await Promise.all([
      receiptIds.length ? financeRest(`timefit_user_finance_documents?id=in.(${receiptIds.map(encodeURIComponent).join(',')})&organization_id=eq.${encodeURIComponent(organizationId)}&select=id,title,file_name,storage_path,mime_type,document_date,processing_status,extracted_data,created_at`) : [],
      cardIds.length ? financeRest(`timefit_user_card_transaction_groups?id=in.(${cardIds.map(encodeURIComponent).join(',')})&organization_id=eq.${encodeURIComponent(organizationId)}&select=id,status,approved_amount,acquired_amount,cancelled_amount,net_amount,approval_number,approved_at,acquired_at,billed_at,merchant_name,card:timefit_user_corporate_cards(issuer,nickname,last4)&order=approved_at.asc`) : [],
      financeRest(`timefit_user_expense_audit_logs?organization_id=eq.${encodeURIComponent(organizationId)}&entity_id=eq.${encodeURIComponent(expenseId)}&select=id,action,before_value,after_value,source,created_at&order=created_at.desc&limit=50`),
    ]);
    return res.status(200).json({ ok: true, expense: expenses[0], sources, documents, transactions, audits });
  } catch (error) { return financeError(res, error, '지출 상세 내역을 불러오지 못했습니다.'); }
}
