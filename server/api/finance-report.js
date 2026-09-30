import { authorizeFinance, financeError, financeRest, financeServerConfigured, methodNotAllowed } from './_finance-server.js';
import { isExpenseAmountAnomalous } from '../domain/expense-amount-validation.js';

const dateOnly = value => String(value || '').slice(0, 10);
const koreaDateKey = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
const daysBetween = (from, to) => Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
const datesInRange = (from, to) => Array.from({ length: daysBetween(from, to) }, (_, index) => new Date(Date.parse(`${from}T00:00:00Z`) + index * 86400000).toISOString().slice(0, 10));
const monthDays = date => new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0).getDate();
const merchantKey = value => String(value || '').toLowerCase().replace(/주식회사|\(주\)|㈜/g, '').replace(/[^0-9a-z가-힣]/g, '') || '미확인업체';

export function buildMerchantExpenseGroups(expenses = []) {
  const groups = new Map();
  expenses.filter(item => !isExpenseAmountAnomalous(item.total_amount)).forEach(expense => {
    const key = merchantKey(expense.merchant_name); const amount = Number(expense.total_amount || 0);
    const group = groups.get(key) || { merchantName: expense.merchant_name || '업체 미확인', totalAmount: 0, receiptCount: 0, categories: {}, uploads: [] };
    group.totalAmount += amount; group.receiptCount += 1;
    const category = String(expense.category || '').trim() || '미분류';
    group.categories[category] = (group.categories[category] || 0) + amount;
    group.uploads.push({ expenseId: expense.id, transactionDate: dateOnly(expense.transaction_date), amount, category, lineItems: (expense.lineItems || []).map(item => ({ id: item.id, name: item.item_name_normalized || item.item_name_raw || '품목 미확인', quantity: item.quantity, unit: item.unit, amount: Number(item.line_amount || 0) })).sort((a, b) => String(a.id).localeCompare(String(b.id))) });
    groups.set(key, group);
  });
  return [...groups.values()].map(group => ({ ...group, category: Object.entries(group.categories).sort((a, b) => b[1] - a[1])[0]?.[0] || '미분류', uploads: group.uploads.sort((a, b) => b.transactionDate.localeCompare(a.transactionDate)) })).sort((a, b) => b.totalAmount - a.totalAmount);
}

export function previousFinanceRange(from, to, periodType = null) {
  if (periodType === 'monthly') {
    const start = new Date(Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 2, 1));
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
  }
  if (periodType === 'annual') return { from: `${Number(from.slice(0, 4)) - 1}-01-01`, to: `${Number(to.slice(0, 4)) - 1}-12-31` };
  const duration = daysBetween(from, to);
  const previousTo = new Date(Date.parse(`${from}T00:00:00Z`) - 86400000);
  const previousFrom = new Date(previousTo.getTime() - (duration - 1) * 86400000);
  return { from: previousFrom.toISOString().slice(0, 10), to: previousTo.toISOString().slice(0, 10) };
}

export function groupFinanceSeries(series = [], periodType = 'monthly') {
  if (periodType !== 'annual') return series;
  const detailed = series.some(day => ['orderCount','confirmedExpenses','provisionalCardExpenses','calculatedExpenses','forecastExpenses','cardFees','rentExpense','dataStatus'].some(field => Object.hasOwn(day, field)));
  if (!detailed) {
    const months = new Map();
    series.forEach(day => {
      const key = day.date.slice(0, 7);
      const row = months.get(key) || { date: key, sales: 0, operatingExpenses: 0, laborCost: 0, operatingProfit: 0 };
      for (const field of ['sales','operatingExpenses','laborCost','operatingProfit']) row[field] += Number(day[field] || 0);
      months.set(key, row);
    });
    return [...months.values()];
  }
  const months = new Map();
  series.forEach(day => {
    const key = day.date.slice(0, 7);
    const row = months.get(key) || { date: key, sales: 0, orderCount: 0, confirmedExpenses: 0, provisionalCardExpenses: 0, calculatedExpenses: 0, forecastExpenses: 0, cardFees: 0, rentExpense: 0, operatingExpenses: 0, laborCost: 0, operatingProfit: 0, actualDays: 0, forecastDays: 0 };
    for (const field of ['sales','orderCount','confirmedExpenses','provisionalCardExpenses','calculatedExpenses','forecastExpenses','cardFees','rentExpense','operatingExpenses','laborCost','operatingProfit']) row[field] += Number(day[field] || 0);
    if (day.dataStatus === 'forecast') row.forecastDays += 1; else row.actualDays += 1;
    months.set(key, row);
  });
  return [...months.values()].map(row => ({ ...row, dataStatus: row.forecastDays && row.actualDays ? 'in_progress' : row.forecastDays ? 'forecast' : 'actual' }));
}

const changeRate = (current, previous) => previous === 0 ? null : Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;

const attendanceMinutes = record => {
  const start = Date.parse(record.checked_in_at || ''); const end = Date.parse(record.checked_out_at || '');
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? Math.round((end - start) / 60000) : 0;
};

export function buildDailyLaborMap({ payrollDrafts = [], payrollLines = [], attendanceRecords = [] }) {
  const draftById = new Map(payrollDrafts.map(draft => [draft.id, dateOnly(draft.settlement_month).slice(0, 7)]));
  const result = new Map(); let actualLines = 0; let fallbackLines = 0;
  [...new Set(draftById.values())].forEach(month => datesInRange(`${month}-01`, `${month}-${String(monthDays(`${month}-01`)).padStart(2, '0')}`).forEach(date => result.set(date, 0)));
  payrollLines.forEach(line => {
    const month = draftById.get(line.payroll_draft_id); const total = Math.round(Number(line.estimated_total || 0));
    if (!month || !total) return;
    const attendance = attendanceRecords.filter(record => record.staff_id === line.staff_id && dateOnly(record.work_date).slice(0, 7) === month && attendanceMinutes(record) > 0);
    let weights = attendance.map(record => ({ date: dateOnly(record.work_date), weight: line.pay_type === 'hourly' ? attendanceMinutes(record) : 1 }));
    if (!weights.length) { fallbackLines += 1; weights = datesInRange(`${month}-01`, `${month}-${String(monthDays(`${month}-01`)).padStart(2, '0')}`).map(date => ({ date, weight: 1 })); } else actualLines += 1;
    const weightTotal = weights.reduce((sum, item) => sum + item.weight, 0); let allocated = 0;
    weights.forEach((item, index) => {
      const amount = index === weights.length - 1 ? total - allocated : Math.round(total * item.weight / weightTotal);
      allocated += amount; result.set(item.date, (result.get(item.date) || 0) + amount);
    });
  });
  result.basis = fallbackLines ? (actualLines ? 'mixed_attendance_and_calendar_fallback' : 'calendar_daily_fallback') : 'attendance_weighted_payroll_draft';
  return result;
}

const sumFinanceRows = rows => rows.reduce((sum, day) => {
  for (const [category, amount] of Object.entries(day.categoryBreakdown || {})) sum.categoryBreakdown[category] = (sum.categoryBreakdown[category] || 0) + Number(amount || 0);
  for (const field of ['netSales','orderCount','confirmedExpenses','provisionalCardExpenses','calculatedExpenses','forecastExpenses','kitchenPurchases','hallPurchases','otherExpenses','cardFees','rentExpense','operatingExpenses','laborCost','operatingProfit']) sum[field] += Number(field === 'netSales' ? day.sales : day[field] || 0);
  return sum;
}, { netSales: 0, orderCount: 0, confirmedExpenses: 0, provisionalCardExpenses: 0, calculatedExpenses: 0, forecastExpenses: 0, kitchenPurchases: 0, hallPurchases: 0, otherExpenses: 0, cardFees: 0, rentExpense: 0, operatingExpenses: 0, laborCost: 0, operatingProfit: 0, categoryBreakdown: {} });
const withFinanceRates = totals => ({ ...totals, averageOrderValue: totals.orderCount ? Math.round(totals.netSales / totals.orderCount) : null, kitchenCostRate: totals.netSales ? Math.round(totals.kitchenPurchases / totals.netSales * 1000) / 10 : null, hallCostRate: totals.netSales ? Math.round(totals.hallPurchases / totals.netSales * 1000) / 10 : null, laborCostRate: totals.netSales ? Math.round(totals.laborCost / totals.netSales * 1000) / 10 : null, profitMargin: totals.netSales ? Math.round((totals.operatingProfit / totals.netSales) * 1000) / 10 : null });

export function buildFinanceReport({ from, to, salesRows = [], expenses = [], unreconciledCardTransactions = [], payrollDrafts = [], payrollLines = [], attendanceRecords = [], unresolvedReceipts = 0, cardFeeRate = 0, revenueRentRate = 0, asOfDate = koreaDateKey() }) {
  const anomalousExpenses = expenses.filter(item => isExpenseAmountAnomalous(item.total_amount));
  const reportableExpenses = expenses.filter(item => !isExpenseAmountAnomalous(item.total_amount));
  const days = datesInRange(from, to); const lineByDraft = new Map();
  payrollLines.forEach(line => lineByDraft.set(line.payroll_draft_id, (lineByDraft.get(line.payroll_draft_id) || 0) + Number(line.estimated_total || 0)));
  const payrollByMonth = new Map(payrollDrafts.map(draft => [dateOnly(draft.settlement_month).slice(0, 7), lineByDraft.get(draft.id) || 0]));
  const dailyLabor = buildDailyLaborMap({ payrollDrafts, payrollLines, attendanceRecords });
  const actualSeries = days.map(date => {
    const daySales = salesRows.filter(row => dateOnly(row.sales_date) === date); const dayExpenses = reportableExpenses.filter(item => dateOnly(item.transaction_date) === date);
    const dayUnreconciledCards = unreconciledCardTransactions.filter(item => dateOnly(item.approved_at) === date);
    const sales = daySales.reduce((sum, row) => sum + Number(row.completed_amount || 0), 0); const orderCount = daySales.reduce((sum, row) => sum + Number(row.completed_order_count || 0), 0);
    const confirmedExpenses = dayExpenses.reduce((sum, item) => sum + Number(item.total_amount || 0), 0);
    const categoryBreakdown = dayExpenses.reduce((result, item) => { const category = String(item.category || '').trim() || '미분류'; result[category] = (result[category] || 0) + Number(item.total_amount || 0); return result; }, {});
    const kitchenPurchases = dayExpenses.filter(item => /주방|식자재|재료/.test(String(item.category || ''))).reduce((sum, item) => sum + Number(item.total_amount || 0), 0);
    const hallPurchases = dayExpenses.filter(item => /홀|음료|주류/.test(String(item.category || ''))).reduce((sum, item) => sum + Number(item.total_amount || 0), 0);
    const provisionalCardExpenses = dayUnreconciledCards.reduce((sum, item) => sum + Number(item.net_amount || 0), 0);
    const otherExpenses = confirmedExpenses - kitchenPurchases - hallPurchases;
    const cardFees = Math.round(sales * Number(cardFeeRate || 0)); const rentExpense = Math.round(sales * Number(revenueRentRate || 0));
    const calculatedExpenses = cardFees + rentExpense; const operatingExpenses = confirmedExpenses + provisionalCardExpenses + calculatedExpenses;
    const month = date.slice(0, 7); const monthlyLabor = payrollByMonth.get(month) || 0;
    const isOpenMonth = month >= asOfDate.slice(0, 7);
    const laborCost = isOpenMonth ? Math.round(monthlyLabor / monthDays(date)) : dailyLabor.has(date) ? dailyLabor.get(date) : Math.round(monthlyLabor / monthDays(date));
    return { date, dataStatus: date === asOfDate ? 'in_progress' : 'actual', sales, orderCount, averageOrderValue: orderCount ? Math.round(sales / orderCount) : null, confirmedExpenses, provisionalCardExpenses, calculatedExpenses, forecastExpenses: 0, kitchenPurchases, hallPurchases, otherExpenses, categoryBreakdown, cardFees, rentExpense, operatingExpenses, laborCost, operatingProfit: sales - operatingExpenses - laborCost };
  });
  const baseline = actualSeries.filter(day => day.date < asOfDate && day.sales > 0);
  const baselineSales = baseline.reduce((sum, day) => sum + day.sales, 0);
  const variableExpenseRate = baselineSales ? Math.min(1, baseline.reduce((sum, day) => sum + day.confirmedExpenses + day.provisionalCardExpenses, 0) / baselineSales) : 0;
  const averageFor = (date, field) => {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const matching = baseline.filter(day => new Date(`${day.date}T00:00:00Z`).getUTCDay() === weekday);
    const source = matching.length ? matching : baseline;
    return source.length ? Math.round(source.reduce((sum, day) => sum + Number(day[field] || 0), 0) / source.length) : 0;
  };
  const series = actualSeries.map(day => {
    if (day.date <= asOfDate) return day;
    const sales = averageFor(day.date, 'sales'); const orderCount = averageFor(day.date, 'orderCount');
    const forecastExpenses = Math.round(sales * variableExpenseRate);
    const cardFees = Math.round(sales * Number(cardFeeRate || 0)); const rentExpense = Math.round(sales * Number(revenueRentRate || 0));
    const calculatedExpenses = cardFees + rentExpense; const operatingExpenses = forecastExpenses + calculatedExpenses;
    return { ...day, dataStatus: 'forecast', sales, orderCount, averageOrderValue: orderCount ? Math.round(sales / orderCount) : null, confirmedExpenses: 0, provisionalCardExpenses: 0, calculatedExpenses, forecastExpenses, kitchenPurchases: 0, hallPurchases: 0, otherExpenses: 0, categoryBreakdown: {}, cardFees, rentExpense, operatingExpenses, operatingProfit: sales - operatingExpenses - day.laborCost };
  });
  const actualRows = series.filter(day => day.dataStatus !== 'forecast'); const forecastRows = series.filter(day => day.dataStatus === 'forecast');
  const totals = sumFinanceRows(series); const actualTotals = sumFinanceRows(actualRows); const forecastTotals = sumFinanceRows(forecastRows);
  const missingPayrollMonths = [...new Set(days.map(date => date.slice(0, 7)).filter(month => !payrollByMonth.has(month)))];
  return { from, to, asOfDate, hasForecast: forecastRows.length > 0, totals: withFinanceRates(totals), actualTotals: withFinanceRates(actualTotals), forecastTotals: withFinanceRates(forecastTotals), merchantExpenseGroups: buildMerchantExpenseGroups(reportableExpenses), forecast: { method: 'weekday_run_rate', baselineDays: baseline.length, variableExpenseRate: Math.round(variableExpenseRate * 1000) / 10 }, assumptions: { cardFeeRate: Number(cardFeeRate || 0), revenueRentRate: Number(revenueRentRate || 0) }, series, anomalies: { expenses: anomalousExpenses.map(item => ({ id: item.id, transactionDate: item.transaction_date, amount: Number(item.total_amount || 0), category: item.category || null })), count: anomalousExpenses.length, amount: anomalousExpenses.reduce((sum, item) => sum + Number(item.total_amount || 0), 0) }, completeness: { payrollComplete: missingPayrollMonths.length === 0, missingPayrollMonths, reviewComplete: Number(unresolvedReceipts) === 0 && anomalousExpenses.length === 0, unresolvedReceipts: Number(unresolvedReceipts), anomalousExpenses: anomalousExpenses.length, laborBasis: dailyLabor.basis } };
}

export function compareFinanceReports(current, previous) {
  return Object.fromEntries(['netSales','operatingExpenses','laborCost','operatingProfit'].map(field => [field, { current: current.totals[field], previous: previous.totals[field], changeRate: changeRate(current.totals[field], previous.totals[field]) }]));
}

export function buildCloseoutCompleteness({ expenses = [], unresolvedReceipts = 0, unresolvedCardTransactions = 0, unhealthyConnections = 0 }) {
  const evidenceTypes = new Set(['receipt','card_transaction_group','tax_invoice','email']);
  const evidencedExpenses = expenses.filter(expense => (expense.sources || []).some(source => evidenceTypes.has(source.source_type))).length;
  const evidenceRate = expenses.length ? Math.round(evidencedExpenses / expenses.length * 1000) / 10 : 100;
  return {
    reviewComplete: Number(unresolvedReceipts) === 0,
    unresolvedReceipts: Number(unresolvedReceipts),
    evidenceComplete: evidencedExpenses === expenses.length,
    evidencedExpenses,
    confirmedExpenses: expenses.length,
    evidenceRate,
    cardReconciliationComplete: Number(unresolvedCardTransactions) === 0,
    unresolvedCardTransactions: Number(unresolvedCardTransactions),
    cardSyncHealthy: Number(unhealthyConnections) === 0,
    unhealthyConnections: Number(unhealthyConnections),
  };
}

async function reportData(organizationId, from, to) {
  const monthFrom = `${from.slice(0, 7)}-01`; const monthTo = `${to.slice(0, 7)}-${String(monthDays(to)).padStart(2, '0')}`;
  const [salesRows, expenses, payrollDrafts, unresolvedDocuments, attendanceRecords, unresolvedCardRows, unhealthyConnections, settingsRows] = await Promise.all([
    financeRest(`timefit_user_tossplace_daily_sales?organization_id=eq.${encodeURIComponent(organizationId)}&sales_date=gte.${from}&sales_date=lte.${to}&select=sales_date,completed_amount,completed_order_count`),
    financeRest(`timefit_user_expenses?organization_id=eq.${encodeURIComponent(organizationId)}&status=eq.confirmed&transaction_date=gte.${from}&transaction_date=lte.${to}&select=id,transaction_date,total_amount,merchant_name,category,sources:timefit_user_expense_sources(source_type),lineItems:timefit_user_receipt_line_items(id,line_number,item_name_raw,item_name_normalized,quantity,unit,line_amount)`),
    financeRest(`timefit_user_payroll_drafts?organization_id=eq.${encodeURIComponent(organizationId)}&settlement_month=gte.${from.slice(0,7)}-01&settlement_month=lte.${to.slice(0,7)}-01&select=id,settlement_month,status`),
    financeRest(`timefit_user_finance_documents?organization_id=eq.${encodeURIComponent(organizationId)}&document_type=eq.receipt&processing_status=in.(queued,processing,review_required,failed)&document_date=gte.${from}&document_date=lte.${to}&select=id`),
    financeRest(`timefit_user_attendance_records?organization_id=eq.${encodeURIComponent(organizationId)}&work_date=gte.${monthFrom}&work_date=lte.${monthTo}&checked_out_at=not.is.null&select=staff_id,work_date,checked_in_at,checked_out_at`),
    financeRest(`timefit_user_card_transaction_groups?organization_id=eq.${encodeURIComponent(organizationId)}&approved_at=gte.${from}T00:00:00%2B09:00&approved_at=lte.${to}T23:59:59%2B09:00&net_amount=gt.0&reconciliation_status=in.(unreviewed,review_required)&select=id,approved_at,net_amount`),
    financeRest(`timefit_user_card_connections?organization_id=eq.${encodeURIComponent(organizationId)}&status=in.(degraded,reauth_required)&select=id`),
    financeRest(`timefit_user_organization_settings?organization_id=eq.${encodeURIComponent(organizationId)}&select=corporate_card_fee_rate,revenue_rent_rate&limit=1`),
  ]);
  const payrollLines = payrollDrafts.length ? await financeRest(`timefit_user_payroll_draft_lines?payroll_draft_id=in.(${payrollDrafts.map(item => encodeURIComponent(item.id)).join(',')})&select=payroll_draft_id,staff_id,pay_type,worked_minutes,completed_work_days,estimated_total`) : [];
  const report = buildFinanceReport({ from, to, salesRows, expenses, unreconciledCardTransactions: unresolvedCardRows, payrollDrafts, payrollLines, attendanceRecords, unresolvedReceipts: unresolvedDocuments.length, cardFeeRate: settingsRows[0]?.corporate_card_fee_rate ?? 0.022, revenueRentRate: settingsRows[0]?.revenue_rent_rate ?? 0.15 });
  const reportableExpenses = expenses.filter(item => !isExpenseAmountAnomalous(item.total_amount));
  report.completeness = { ...buildCloseoutCompleteness({ expenses: reportableExpenses, unresolvedReceipts: unresolvedDocuments.length, unresolvedCardTransactions: unresolvedCardRows.length, unhealthyConnections: unhealthyConnections.length }), ...report.completeness };
  report.completeness.closeoutReady = report.completeness.payrollComplete && report.completeness.reviewComplete && report.completeness.evidenceComplete && report.completeness.cardReconciliationComplete && report.completeness.cardSyncHealthy;
  return report;
}

export default async function handler(req, res) {
  if (!['GET','POST'].includes(req.method)) return methodNotAllowed(res);
  if (!financeServerConfigured()) return res.status(503).json({ ok: false, error: '금융 처리 서버 설정이 필요합니다.' });
  const source = req.method === 'GET' ? req.query : req.body || {};
  const { organizationId, from, to } = source;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '') || from > to || daysBetween(from, to) > 370) return res.status(400).json({ ok: false, error: '조회 기간은 최대 370일 이내로 선택해 주세요.' });
  const periodType = ['daily','weekly','monthly','annual'].includes(source.periodType) ? source.periodType : 'monthly';
  const auth = await authorizeFinance(req, organizationId, { ownerOnly: req.method === 'POST' });
  if (!auth) return res.status(req.headers.authorization ? 403 : 401).json({ ok: false, error: req.method === 'POST' ? '결산 저장은 사업장 소유자만 할 수 있습니다.' : '관리자 인증이 필요합니다.' });
  try {
    const report = await reportData(organizationId, from, to);
    report.displaySeries = groupFinanceSeries(report.series, periodType);
    if (req.method === 'GET') {
      const previousRange = previousFinanceRange(from, to, periodType);
      const [previous, closedRows] = await Promise.all([
        reportData(organizationId, previousRange.from, previousRange.to),
        financeRest(`timefit_user_closeouts?organization_id=eq.${encodeURIComponent(organizationId)}&period_type=eq.${periodType}&period_start=eq.${from}&period_end=eq.${to}&status=eq.closed&select=id,version,status,source_cutoff_at,closed_by,closed_at&order=version.desc&limit=1`),
      ]);
      report.comparison = { range: previousRange, metrics: compareFinanceReports(report, previous) };
      const closed = closedRows[0] || null;
      let closedByName = null;
      if (closed?.closed_by) {
        const accounts = await financeRest(`timefit_user_accounts?id=eq.${encodeURIComponent(closed.closed_by)}&select=display_name&limit=1`).catch(() => []);
        closedByName = accounts[0]?.display_name || null;
      }
      report.audit = closed ? { status: 'closed', version: closed.version, sourceCutoffAt: closed.source_cutoff_at, closedAt: closed.closed_at, closedByName: closedByName || '사업장 소유자' } : { status: 'preview', generatedAt: new Date().toISOString() };
    }
    if (req.method === 'GET') return res.status(200).json({ ok: true, report });
    const existing = await financeRest(`timefit_user_closeouts?organization_id=eq.${encodeURIComponent(organizationId)}&period_type=eq.${periodType}&period_start=eq.${from}&period_end=eq.${to}&select=version&order=version.desc&limit=1`);
    const version = Number(existing[0]?.version || 0) + 1; const now = new Date().toISOString();
    const closeoutTotals = report.hasForecast ? report.actualTotals : report.totals;
    const rows = await financeRest('timefit_user_closeouts', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{ organization_id: organizationId, period_type: periodType, period_start: from, period_end: to, version, status: report.completeness.closeoutReady && !report.hasForecast ? 'ready' : 'draft', source_cutoff_at: now, net_sales: closeoutTotals.netSales, operating_expenses: closeoutTotals.operatingExpenses, labor_cost: closeoutTotals.laborCost, operating_profit: closeoutTotals.operatingProfit, summary: { ...report.completeness, hasForecast: report.hasForecast, projection: report.hasForecast ? report.totals : null } }]) });
    const closeout = rows[0];
    const lines = [
      { line_type: 'net_sales', amount: closeoutTotals.netSales }, { line_type: 'operating_expenses', amount: closeoutTotals.operatingExpenses },
      { line_type: 'confirmed_expenses', amount: closeoutTotals.confirmedExpenses }, { line_type: 'kitchen_purchases', amount: closeoutTotals.kitchenPurchases },
      { line_type: 'provisional_card_expenses', amount: closeoutTotals.provisionalCardExpenses },
      { line_type: 'hall_purchases', amount: closeoutTotals.hallPurchases }, { line_type: 'card_fees', amount: closeoutTotals.cardFees },
      { line_type: 'revenue_rent', amount: closeoutTotals.rentExpense }, { line_type: 'labor_cost', amount: closeoutTotals.laborCost }, { line_type: 'operating_profit', amount: closeoutTotals.operatingProfit },
    ].map(line => ({ organization_id: organizationId, closeout_id: closeout.id, ...line, count: 0, metadata: { from, to } }));
    await financeRest('timefit_user_closeout_lines', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(lines) });
    return res.status(201).json({ ok: true, closeout, report });
  } catch (error) { return financeError(res, error, '결산 보고서를 생성하지 못했습니다.'); }
}
