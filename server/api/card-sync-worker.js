import { financeError, financeRest, financeServerConfigured, methodNotAllowed } from './_finance-server.js';
import { runCardSync } from './_card-sync-runner.js';

const authorized = req => {
  const supplied = req.headers.authorization;
  return [process.env.CARD_SYNC_CRON_SECRET, process.env.CRON_SECRET].filter(Boolean).some(secret => supplied === `Bearer ${secret}`);
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (!financeServerConfigured()) return res.status(503).json({ ok: false, error: 'Missing server configuration' });

  try {
    const now = new Date(); const bucket = now.toISOString().slice(0, 13);
    const connections = await financeRest(`timefit_user_card_connections?status=in.(active,degraded)&next_sync_at=lte.${encodeURIComponent(now.toISOString())}&select=*&order=next_sync_at.asc&limit=10`);
    const results = [];
    for (const connection of connections) {
      const idempotencyKey = `${connection.id}:incremental:${bucket}`;
      const existing = await financeRest(`timefit_user_card_sync_runs?organization_id=eq.${encodeURIComponent(connection.organization_id)}&idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=id,status`);
      if (existing.length) { results.push({ connectionId: connection.id, status: 'skipped', runId: existing[0].id }); continue; }
      try {
        const runs = await financeRest('timefit_user_card_sync_runs', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{ organization_id: connection.organization_id, connection_id: connection.id, sync_type: 'approvals', idempotency_key: idempotencyKey, status: 'queued', attempt_count: 0 }]) });
        const result = await runCardSync({ connection, runId: runs[0].id, mode: 'incremental' });
        results.push({ connectionId: connection.id, runId: runs[0].id, status: 'succeeded', ...result });
      } catch (error) {
        results.push({ connectionId: connection.id, status: 'failed', error: String(error.message || 'sync_failed').slice(0, 120) });
      }
    }
    return res.status(200).json({ ok: true, processed: results.length, succeeded: results.filter(item => item.status === 'succeeded').length, failed: results.filter(item => item.status === 'failed').length, results });
  } catch (error) {
    return financeError(res, error, '예약 카드 동기화를 완료하지 못했습니다.');
  }
}
