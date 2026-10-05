import { decryptSecret } from './_integration-crypto.js';
import { authorizeFinance } from './_finance-server.js';

const TOSS_API = "https://open-api.tossplace.com/api-public/openapi/v1";

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && req.headers.authorization === `Bearer ${secret}`;
}

async function authorizeManager(req, organizationId) {
  return Boolean(await authorizeFinance(req, organizationId, { permissionsAny: ['sales.sync'] }));
}

function asDate(value) {
  return value && !Number.isNaN(Date.parse(value)) ? value : null;
}

export function normalizeSalesSyncRange(from, to) {
  const pattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!from && !to) return null;
  if (!pattern.test(from || '') || !pattern.test(to || '')) throw new Error('동기화 기간은 시작일과 종료일을 모두 선택해 주세요.');
  const start = new Date(`${from}T00:00:00+09:00`);
  const end = new Date(`${to}T23:59:59.999+09:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) throw new Error('동기화 기간을 확인해 주세요.');
  if (end.getTime() - start.getTime() > 366 * 86400000) throw new Error('한 번에 동기화할 수 있는 기간은 최대 1년입니다.');
  return { from: start.toISOString(), to: end.toISOString() };
}

export function dailySalesSyncRange(now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(now);
  const start = new Date(`${today}T00:00:00+09:00`);
  const cutoff = new Date(`${today}T22:00:00+09:00`);
  return { from: new Date(start.getTime() - 86400000).toISOString(), to: new Date(Math.min(+now, +cutoff)).toISOString() };
}

function normalizeOrder(order, merchantId, organizationId) {
  return {
    organization_id: organizationId,
    merchant_id: Number(merchantId),
    order_id: String(order.id),
    order_key: order.orderKey ?? null,
    state: order.orderState ?? order.state ?? null,
    source: order.source ?? null,
    ordered_at: asDate(order.createdAt ?? order.orderedAt),
    completed_at: asDate(order.completedAt),
    cancelled_at: asDate(order.cancelledAt),
    total_amount: Number(order.chargePrice?.totalAmount ?? order.totalAmount ?? order.totalPrice?.amount ?? order.amount) || 0,
    raw_order: order,
    synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function upsertOrders(rows) {
  if (!rows.length) return;
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/tossplace_orders?on_conflict=merchant_id,order_id`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!response.ok) throw new Error(`Supabase order upsert failed: ${response.status}`);
}

async function saveSyncState(state) {
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/tossplace_sync_state?on_conflict=merchant_id`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([state]),
  });
  if (!response.ok) throw new Error(`Supabase sync state write failed: ${response.status}`);
}

async function createSyncRun({ organizationId, merchantId, mode, range }) {
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_sales_sync_runs`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify([{ organization_id: organizationId, merchant_id: Number(merchantId), requested_mode: mode, window_from: range.from, window_to: range.to }]),
  });
  if (!response.ok) throw new Error(`Supabase sync run write failed: ${response.status}`);
  return (await response.json())[0];
}

async function updateSyncRun(id, patch) {
  if (!id) return;
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_sales_sync_runs?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!response.ok) throw new Error(`Supabase sync run update failed: ${response.status}`);
}

const kstDateFor = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(value));

async function refreshDailySalesSummary(organizationId, merchantId, range) {
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/timefit_user_refresh_tossplace_daily_sales`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_organization_id: organizationId, p_merchant_id: Number(merchantId), p_from: kstDateFor(range.from), p_to: kstDateFor(range.to) }),
  });
  if (!response.ok) throw new Error(`Supabase daily summary refresh failed: ${response.status}`);
}

async function readConnections(organizationId) {
  const filter = organizationId
    ? `organization_id=eq.${encodeURIComponent(organizationId)}&sync_enabled=eq.true`
    : 'sync_enabled=eq.true&merchant_id=not.is.null';
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_tossplace_connections?${filter}&select=organization_id,merchant_id,service_id,service_code,credential_source,encrypted_access_key,encrypted_access_secret`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!response.ok) throw new Error(`Supabase Toss connection read failed: ${response.status}`);
  const rows = await response.json();
  if (organizationId && !rows.length) throw new Error('Toss Place connection not found or disabled');
  return rows;
}

async function syncConnection({ organizationId, merchantId, page, size, mode, range, credentialSource, encryptedAccessKey, encryptedAccessSecret }) {
  const accessKey = credentialSource === 'custom' ? decryptSecret(encryptedAccessKey) : process.env.TOSSPLACE_ACCESS_KEY;
  const accessSecret = credentialSource === 'custom' ? decryptSecret(encryptedAccessSecret) : process.env.TOSSPLACE_ACCESS_SECRET;
  if (!accessKey || !accessSecret) throw new Error('Toss Place credentials are unavailable');
  const fetchRange = range || dailySalesSyncRange();
  const run = await createSyncRun({ organizationId, merchantId, mode, range: fetchRange });
  await saveSyncState({ merchant_id: Number(merchantId), organization_id: organizationId, last_sync_started_at: new Date().toISOString(), last_sync_error: null, updated_at: new Date().toISOString() });
  let currentPage = page; let pagesFetched = 0; let synchronized = 0; let pageComplete = false;
  try {
    for (let batch = 0; batch < 100; batch += 1) {
      const params = new URLSearchParams({ page: String(currentPage), size: String(size), sortOrder: 'DESC', from: fetchRange.from, to: fetchRange.to });
      const response = await fetch(`${TOSS_API}/merchants/${merchantId}/order/orders?${params}`, { headers: { 'x-access-key': accessKey, 'x-secret-key': accessSecret, 'Content-Type': 'application/json' } });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.resultType !== 'SUCCESS') {
        const detail = String(body?.error?.message || body?.message || body?.errorCode || '').slice(0, 160);
        if (response.status === 401) throw new Error('Toss Place 인증에 실패했습니다. Access Key·Secret과 POS 서비스 코드 연결을 확인해 주세요.');
        if (response.status === 403) throw new Error('Toss Place 주문 조회 권한이 없습니다. 해당 앱에 매장 주문 조회 권한이 있는지 확인해 주세요.');
        if (response.status === 404) throw new Error('Toss Place 판매점 ID 또는 주문 조회 경로를 확인해 주세요.');
        throw new Error(detail ? `Toss Place 주문 조회 실패 (${response.status}): ${detail}` : `Toss Place 주문 조회 실패 (${response.status})`);
      }
      const orders = Array.isArray(body.success) ? body.success : (body.success?.items ?? []);
      await upsertOrders(orders.filter(order => order?.id).map(order => normalizeOrder(order, merchantId, organizationId)));
      pagesFetched += 1; synchronized += orders.length;
      if (orders.length < size) { pageComplete = true; break; }
      currentPage += 1;
    }
    if (!pageComplete) throw new Error('Toss Place 주문 수집 상한에 도달했습니다. 기간을 나눠 다시 수집해 주세요.');
    await refreshDailySalesSummary(organizationId, merchantId, fetchRange);
    const completedAt = new Date().toISOString();
    await updateSyncRun(run.id, { status: 'succeeded', completed_at: completedAt, pages_fetched: pagesFetched, orders_received: synchronized, page_complete: true, summary_refresh_completed: true });
    await saveSyncState({ merchant_id: Number(merchantId), organization_id: organizationId, last_successful_sync_at: completedAt, last_successful_window_from: fetchRange.from, last_successful_window_to: fetchRange.to, last_sync_started_at: completedAt, last_sync_error: null, updated_at: completedAt });
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_tossplace_connections?organization_id=eq.${encodeURIComponent(organizationId)}`, { method: 'PATCH', headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ connection_status: 'connected', last_synced_at: completedAt, last_error: null }) });
    return { synchronized, runId: run.id, pagesFetched, pageComplete: true, window: fetchRange };
  } catch (error) {
    await updateSyncRun(run.id, { status: synchronized ? 'partial' : 'failed', completed_at: new Date().toISOString(), pages_fetched: pagesFetched, orders_received: synchronized, page_complete: false, error_code: 'toss_sync_failed', error_message: String(error.message || error).slice(0, 300) }).catch(() => {});
    throw error;
  }
}

async function markConnectionError(organizationId, message) {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_tossplace_connections?organization_id=eq.${encodeURIComponent(organizationId)}`, {
    method: 'PATCH',
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ connection_status: 'error', last_error: message.slice(0, 300) }),
  }).catch(() => {});
}

async function saveSyncFailure(organizationId, message) {
  if (!organizationId) return;
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/tossplace_sync_state?organization_id=eq.${encodeURIComponent(organizationId)}`, {
    method: 'PATCH',
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ last_sync_error: String(message || 'sync_failed').slice(0, 300), updated_at: new Date().toISOString() }),
  }).catch(() => {});
}

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ ok: false, error: "Method not allowed" });

  const requestedOrganizationId = typeof req.query.organizationId === 'string' ? req.query.organizationId : req.body?.organizationId || null;
  const cronRequest = isAuthorized(req);
  if (!cronRequest && !(req.method === 'POST' && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && await authorizeManager(req, requestedOrganizationId))) return res.status(401).json({ ok: false, error: '관리자 인증이 필요합니다.' });

  const required = [process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY];
  if (required.some(value => !value)) return res.status(503).json({ ok: false, error: "Missing server configuration" });

  const page = Math.max(1, Number.parseInt(req.query.page ?? "1", 10) || 1);
  const size = Math.min(500, Math.max(1, Number.parseInt(req.query.size ?? "500", 10) || 500));
  const requestedMode = req.query.mode ?? req.body?.mode;
  const mode = requestedMode === 'backfill' ? 'backfill' : requestedMode === 'range' ? 'range' : 'daily';
  const requestedFrom = req.query.from ?? req.body?.from;
  const requestedTo = req.query.to ?? req.body?.to;
  const organizationId = cronRequest ? requestedOrganizationId : requestedOrganizationId;

  try {
    const range = normalizeSalesSyncRange(requestedFrom, requestedTo);
    const connections = await readConnections(organizationId);
    if (!connections.length) return res.status(200).json({ ok: true, mode, synchronized: 0, stores: 0, message: 'No enabled Toss Place store connection' });
    const results = [];
    for (const connection of connections) {
      if (!connection.merchant_id) continue;
      try {
        const result = await syncConnection({ organizationId: connection.organization_id, merchantId: connection.merchant_id, page, size, mode, range, credentialSource: connection.credential_source, encryptedAccessKey: connection.encrypted_access_key, encryptedAccessSecret: connection.encrypted_access_secret });
        results.push({ organizationId: connection.organization_id, status: 'completed', ...result });
      } catch (error) {
        console.error('Toss Place store sync failed', { organizationId: connection.organization_id, message: error.message });
        await Promise.all([
          markConnectionError(connection.organization_id, error.message || 'sync_failed'),
          saveSyncFailure(connection.organization_id, error.message || 'sync_failed'),
        ]);
        results.push({ organizationId: connection.organization_id, status: 'failed', synchronized: 0, error: error.message });
      }
    }
    const failed = results.filter(result => result.status === 'failed').length;
    return res.status(organizationId && failed ? 502 : 200).json({
      ok: failed === 0, status: failed ? 'partial_failure' : 'completed', mode, page,
      synchronized: results.reduce((sum, item) => sum + item.synchronized, 0),
      stores: results.length, failed, results,
      error: organizationId && failed ? results.find(result => result.status === 'failed')?.error : undefined,
    });
  } catch (error) {
    if (organizationId) {
      await Promise.all([
        markConnectionError(organizationId, error.message || 'sync_failed'),
        saveSyncFailure(organizationId, error.message || 'sync_failed'),
      ]);
    }
    console.error("Toss Place sales sync failed", { organizationId, mode, page, message: error.message });
    const authFailure = /인증에 실패/.test(error.message || '');
    return res.status(authFailure ? 422 : 502).json({ ok: false, error: error.message || 'Toss Place 주문 동기화에 실패했습니다.', code: authFailure ? 'toss_auth_failed' : 'toss_sync_failed' });
  }
}
