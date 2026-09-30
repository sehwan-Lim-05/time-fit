import { authorizeFinance, financeError, financeRest, financeServerConfigured, methodNotAllowed } from './_finance-server.js';
import { expenseAmountError } from '../domain/expense-amount-validation.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export function summarizeExpenses(items = []) {
  return {
    count: items.length,
    totalAmount: items.filter(item => item.status !== 'excluded').reduce((sum, item) => sum + Number(item.total_amount || 0), 0),
    confirmedAmount: items.filter(item => item.status === 'confirmed').reduce((sum, item) => sum + Number(item.total_amount || 0), 0),
    reviewCount: items.filter(item => item.status === 'review_required').length,
    missingEvidenceCount: items.filter(item => !item.sources?.some(source => source.source_type === 'receipt')).length,
  };
}
export function validateManualExpense(input = {}) {
  const total = Number(input.totalAmount); const supply = input.supplyAmount === '' || input.supplyAmount == null ? null : Number(input.supplyAmount); const vat = input.vatAmount === '' || input.vatAmount == null ? null : Number(input.vatAmount);
  if (!DATE_PATTERN.test(input.transactionDate || '') || !Number.isInteger(total) || total <= 0) return { error: '거래일과 총금액을 확인해 주세요.' };
  if (expenseAmountError(total)) return { error: expenseAmountError(total) };
  if ((supply == null) !== (vat == null) || (supply != null && (!Number.isInteger(supply) || !Number.isInteger(vat) || supply < 0 || vat < 0 || supply + vat !== total))) return { error: '공급가액과 부가세의 합계가 총금액과 일치해야 합니다.' };
  return { transactionDate: input.transactionDate, totalAmount: total, supplyAmount: supply, vatAmount: vat, merchantName: String(input.merchantName || '').trim(), category: String(input.category || '').trim(), reason: String(input.reason || '').trim(), staffId: input.staffId || null, allowDuplicate: Boolean(input.allowDuplicate) };
}

export default async function handler(req, res) {
  if (!['GET','POST'].includes(req.method)) return methodNotAllowed(res);
  if (!financeServerConfigured()) return res.status(503).json({ ok: false, error: '금융 처리 서버 설정이 필요합니다.' });
  const source = req.method === 'GET' ? req.query || {} : req.body || {};
  const { organizationId, from, to, status, category, query } = source;
  const auth = await authorizeFinance(req, organizationId);
  if (!auth) return res.status(req.headers.authorization ? 403 : 401).json({ ok: false, error: '관리자 인증이 필요합니다.' });
  if (req.method === 'POST') {
    const validated = validateManualExpense(source);
    if (validated.error) return res.status(400).json({ ok: false, error: validated.error });
    try {
      const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/timefit_user_create_manual_expense`, { method: 'POST', headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_organization_id: organizationId, p_transaction_date: validated.transactionDate, p_total_amount: validated.totalAmount, p_supply_amount: validated.supplyAmount, p_vat_amount: validated.vatAmount, p_merchant_name: validated.merchantName || null, p_category: validated.category || null, p_reason: validated.reason || null, p_staff_id: validated.staffId, p_allow_duplicate: validated.allowDuplicate }) });
      const expense = await response.json().catch(() => null);
      if (!response.ok) { if (/possible_duplicate_expense/.test(expense?.message || '')) return res.status(409).json({ ok: false, code: 'possible_duplicate_expense', error: '같은 날짜·사용처·금액의 지출이 이미 있습니다.', duplicate: true }); throw new Error(expense?.message || `manual_expense_${response.status}`); }
      return res.status(201).json({ ok: true, expense });
    } catch (error) { return financeError(res, error, '직접 지출을 등록하지 못했습니다.'); }
  }
  if ((from && !DATE_PATTERN.test(from)) || (to && !DATE_PATTERN.test(to))) return res.status(400).json({ ok: false, error: '조회 기간을 확인해 주세요.' });
  try {
    const filters = [`organization_id=eq.${encodeURIComponent(organizationId)}`];
    if (from) filters.push(`transaction_date=gte.${from}`);
    if (to) filters.push(`transaction_date=lte.${to}`);
    if (['draft','review_required','confirmed','excluded','adjusted'].includes(status)) filters.push(`status=eq.${status}`);
    if (category) filters.push(`category=eq.${encodeURIComponent(category)}`);
    if (query) filters.push(`or=(merchant_name.ilike.*${encodeURIComponent(String(query).slice(0, 50))}*,reason.ilike.*${encodeURIComponent(String(query).slice(0, 50))}*)`);
    const items = await financeRest(`timefit_user_expenses?${filters.join('&')}&select=id,ledger_entry_id,transaction_date,total_amount,supply_amount,vat_amount,merchant_name,merchant_business_number,category,reason,status,source_confidence,confirmed_at,created_at,staff:timefit_user_staff(display_name,department),sources:timefit_user_expense_sources(id,source_type,source_id,is_primary)&order=transaction_date.desc,created_at.desc&limit=500`);
    return res.status(200).json({ ok: true, items, summary: summarizeExpenses(items) });
  } catch (error) { return financeError(res, error, '지출 원장을 불러오지 못했습니다.'); }
}
