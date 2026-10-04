import { authorizeFinance, financeRest, financeServerConfigured } from './_finance-server.js';
import { addDays, kstDate, recentCompletedWeek, validDate, weeklySales } from '../../shared/operations.js';

// Never silently truncate a busy store at PostgREST's row limit.
export async function readAll(path, read = financeRest) {
  const rows = [];
  for (let offset = 0; offset < 100000; offset += 500) {
    const page = await read(`${path}&limit=500&offset=${offset}`);
    if (!Array.isArray(page)) throw new Error('Invalid source response');
    rows.push(...page);
    if (page.length < 500) return rows;
  }
  throw new Error('Source exceeds safe aggregation limit');
}

export async function loadWeeklyFeedback(organizationId, range) {
  const org = `organization_id=eq.${encodeURIComponent(organizationId)}`;
  const connections = await financeRest(`timefit_user_tossplace_connections?${org}&select=merchant_id,last_synced_at,last_error&limit=1`);
  const connection = connections[0];
  if (!connection?.merchant_id) return weeklySales([], [], range, null);
  const merchant = `merchant_id=eq.${encodeURIComponent(connection.merchant_id)}`;
  const [orders, daily, syncRuns] = await Promise.all([
    readAll(`tossplace_orders?${org}&${merchant}&ordered_at=gte.${encodeURIComponent(`${range.previousFrom}T00:00:00+09:00`)}&ordered_at=lt.${encodeURIComponent(`${addDays(range.to, 1)}T00:00:00+09:00`)}&select=order_id,ordered_at,state,total_amount,raw_order&order=order_id.asc`),
    financeRest(`timefit_user_tossplace_daily_sales?${org}&${merchant}&sales_date=gte.${range.previousFrom}&sales_date=lte.${range.to}&select=sales_date,order_count,completed_order_count,completed_amount,cancelled_count,finalization_status,revision_number,last_source_synced_at`),
    financeRest(`timefit_user_sales_sync_runs?${org}&${merchant}&status=eq.succeeded&select=id,window_from,window_to,page_complete,status,completed_at,orders_received,pages_fetched&order=completed_at.desc&limit=50`),
  ]);
  return weeklySales(orders, daily, range, connection, syncRuns);
}

export default async function handler(req, res) {
  res.setHeader?.('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!financeServerConfigured()) return res.status(503).json({ ok: false, error: '운영 요약 서버 설정이 필요합니다.' });
  const { organizationId, scope = 'weekly', from } = req.query || {};
  if (typeof organizationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(organizationId) || !['weekly', 'tasks', 'cards'].includes(scope)) return res.status(400).json({ ok: false, error: '조회 조건을 확인해 주세요.' });
  try {
    const auth = await authorizeFinance(req, organizationId, scope === 'weekly' ? { permissionsAny: ['sales.view'] } : { ownerOnly: true });
    if (!auth) return res.status(req.headers.authorization ? 403 : 401).json({ ok: false, error: scope === 'weekly' ? '매출 조회 권한이 필요합니다.' : '최고관리자 권한이 필요합니다.' });
    const today = kstDate();
    const org = `organization_id=eq.${encodeURIComponent(organizationId)}`;
    if (scope === 'weekly') {
      if (from !== undefined && (!validDate(from) || addDays(from, 6) >= today)) return res.status(400).json({ ok: false, error: '어제까지 완료된 7일 기간을 선택해 주세요.' });
      const range = from ? { from, to: addDays(from, 6), previousFrom: addDays(from, -7), previousTo: addDays(from, -1) } : recentCompletedWeek(today);
      return res.status(200).json({ ok: true, data: await loadWeeklyFeedback(organizationId, range) });
    }
    const month = req.query.month || today.slice(0, 7);
    if (!validDate(`${month}-01`)) return res.status(400).json({ ok: false, error: '조회 월을 확인해 주세요.' });
    const start = `${month}-01`, end = addDays(start, 32).slice(0, 7) + '-01';
    const cards = await readAll(`timefit_user_card_transaction_groups?${org}&reconciliation_status=eq.unreviewed&net_amount=gt.0&approved_at=gte.${encodeURIComponent(`${start}T00:00:00+09:00`)}&approved_at=lt.${encodeURIComponent(`${end}T00:00:00+09:00`)}&select=id,merchant_name,approved_at,net_amount,status,reconciliation_status,card:timefit_user_corporate_cards(nickname,last4)&order=approved_at.asc,id.asc`);
    if (scope === 'cards') return res.status(200).json({ ok: true, data: { month, cards } });
    const drafts = await financeRest(`timefit_user_payroll_drafts?${org}&settlement_month=eq.${start}&select=updated_at,status&limit=1`);
    // Changes in old records are visible through updated_at, not clock-out time.
    const latest = await financeRest(`timefit_user_attendance_records?${org}&work_date=gte.${start}&work_date=lt.${end}&select=updated_at&order=updated_at.desc&limit=1`);
    return res.status(200).json({ ok: true, data: { month, cardCount: cards.length, cardAmount: cards.reduce((sum, row) => sum + Number(row.net_amount), 0), draft: drafts[0] || null, attendanceChanged: Boolean(drafts[0] && latest[0]?.updated_at > drafts[0].updated_at) } });
  } catch {
    return res.status(502).json({ ok: false, error: '운영 요약을 불러오지 못했습니다. 다시 시도해 주세요.' });
  }
}
