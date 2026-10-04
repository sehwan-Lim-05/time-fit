import { authorizeFinance, financeError, financeRest, financeServerConfigured, methodNotAllowed } from './_finance-server.js';
import { runCardSync } from './_card-sync-runner.js';

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return methodNotAllowed(res);
  if (!financeServerConfigured()) return res.status(503).json({ ok: false, error: '금융 연결 서버 설정이 필요합니다.' });
  const organizationId = req.method === 'GET' ? req.query?.organizationId : req.body?.organizationId;
  const auth = await authorizeFinance(req, organizationId);
  if (!auth) return res.status(req.headers.authorization ? 403 : 401).json({ ok: false, error: '관리자 인증이 필요합니다.' });

  try {
    if (req.method === 'GET') {
      const runId = String(req.query?.runId || '');
      if (!runId) return res.status(400).json({ ok: false, error: '동기화 작업 ID가 필요합니다.' });
      const runs = await financeRest(`timefit_user_card_sync_runs?id=eq.${encodeURIComponent(runId)}&organization_id=eq.${encodeURIComponent(organizationId)}&select=*`);
      if (!runs.length) return res.status(404).json({ ok: false, error: '동기화 작업을 찾을 수 없습니다.' });
      return res.status(200).json({ ok: true, run: runs[0] });
    }

    const { connectionId, mode = 'backfill' } = req.body || {};
    const now = new Date();
    const timeBucket = mode === 'backfill' ? 'initial' : now.toISOString().slice(0, 13);
    const idempotencyKey = `${connectionId}:${mode}:${timeBucket}`;
    const connections = await financeRest(`timefit_user_card_connections?id=eq.${encodeURIComponent(connectionId)}&organization_id=eq.${encodeURIComponent(organizationId)}&select=*`);
    const connection = connections[0];
    if (!connection) return res.status(404).json({ ok: false, error: '카드 연결을 찾을 수 없습니다.' });
    const existing = await financeRest(`timefit_user_card_sync_runs?organization_id=eq.${encodeURIComponent(organizationId)}&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=*`);
    if (existing.length) return res.status(200).json({ ok: true, duplicateRequest: true, run: existing[0] });
    const runs = await financeRest('timefit_user_card_sync_runs', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{ organization_id: organizationId, connection_id: connectionId, sync_type: 'approvals', idempotency_key: idempotencyKey, status: 'queued', attempt_count: 0 }]),
    });
    const result = await runCardSync({ connection, runId: runs[0].id, mode, userToken: auth.token });
    return res.status(200).json({ ok: true, result, runId: runs[0].id });
  } catch (error) {
    return financeError(res, error, '카드 내역을 동기화하지 못했습니다.');
  }
}
