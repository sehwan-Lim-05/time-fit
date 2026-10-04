import { financeRest, serviceHeaders } from './_finance-server.js';
import { cardProvider } from './providers/card-provider.js';

export const cardSyncErrorCategory = error => {
  const message = String(error?.message || error || '').toLowerCase();
  if (/auth|credential|unauthorized|forbidden|401|403|인증|로그인/.test(message)) return 'authentication';
  if (/429|rate|too many/.test(message)) return 'rate_limit';
  if (/503|maintenance|temporarily unavailable|점검/.test(message)) return 'provider_maintenance';
  if (/timeout|network|fetch/.test(message)) return 'network';
  if (/invalid|not_found|missing/.test(message)) return 'invalid_request';
  return 'unknown';
};

export function cardRetryPlan({ category, failureCount = 1, now = new Date() }) {
  if (category === 'authentication') return { status: 'reauth_required', nextSyncAt: null };
  const fixedMinutes = { rate_limit: 240, provider_maintenance: 120, invalid_request: 1440 };
  const baseMinutes = category === 'network' ? 15 : 60;
  const minutes = fixedMinutes[category] || Math.min(baseMinutes * (2 ** Math.max(0, failureCount - 1)), 360);
  return { status: 'degraded', nextSyncAt: new Date(new Date(now).getTime() + minutes * 60000).toISOString() };
}

export function cardSyncWindow({ mode = 'incremental', succeededThrough = null, now = new Date() }) {
  const end = new Date(now);
  let start = mode === 'backfill' ? new Date(end.getTime() - 90 * 86400000) : succeededThrough ? new Date(new Date(succeededThrough).getTime() - 7 * 86400000) : new Date(end.getTime() - 7 * 86400000);
  if (Number.isNaN(start.getTime()) || start >= end) start = new Date(end.getTime() - 7 * 86400000);
  return { from: start.toISOString(), to: end.toISOString() };
}

async function importEvents(token, organizationId, cardId, provider, events) {
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/timefit_user_import_card_events`, {
    method: 'POST',
    headers: { ...serviceHeaders(), Authorization: `Bearer ${token || process.env.SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ p_organization_id: organizationId, p_corporate_card_id: cardId, p_provider: provider, p_events: events }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.message || `event_import_${response.status}`);
  return body;
}

export async function runCardSync({ connection, runId, mode = 'incremental', userToken = null }) {
  const startedAt = new Date().toISOString();
  await financeRest(`timefit_user_card_sync_runs?id=eq.${encodeURIComponent(runId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'running', attempt_count: 1, started_at: startedAt }) });
  try {
    const cards = await financeRest(`timefit_user_corporate_cards?organization_id=eq.${encodeURIComponent(connection.organization_id)}&connection_id=eq.${encodeURIComponent(connection.id)}&archived_at=is.null&status=eq.active&select=*`);
    if (!cards.length) throw new Error('selected_card_not_found');
    const provider = cardProvider(connection.provider, connection);
    let imported = 0; let duplicates = 0; let groups = 0;
    for (const card of cards) {
      const cursors = await financeRest(`timefit_user_card_sync_cursors?connection_id=eq.${encodeURIComponent(connection.id)}&corporate_card_id=eq.${encodeURIComponent(card.id)}&sync_type=eq.approvals&select=id,cursor_value,succeeded_through&limit=1`);
      const cursor = cursors[0] || null; const window = cardSyncWindow({ mode, succeededThrough: cursor?.succeeded_through });
      const events = await provider.fetchEvents({ organizationId: connection.organization_id, card, mode, cursor: cursor?.cursor_value || null, ...window });
      const result = await importEvents(userToken, connection.organization_id, card.id, connection.provider, events);
      imported += Number(result?.imported || 0); duplicates += Number(result?.duplicates || 0); groups += Number(result?.groups || 0);
      await financeRest('timefit_user_card_sync_cursors?on_conflict=connection_id,corporate_card_id,sync_type', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ organization_id: connection.organization_id, connection_id: connection.id, corporate_card_id: card.id, sync_type: 'approvals', cursor_value: events.nextCursor || null, succeeded_through: window.to, updated_at: new Date().toISOString() }]) });
    }
    const finishedAt = new Date().toISOString();
    await financeRest(`timefit_user_card_sync_runs?id=eq.${encodeURIComponent(runId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'succeeded', request_count: cards.length, inserted_count: imported, duplicate_count: duplicates, finished_at: finishedAt }) });
    await financeRest(`timefit_user_card_connections?id=eq.${encodeURIComponent(connection.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'active', last_attempted_at: finishedAt, last_succeeded_at: finishedAt, next_sync_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(), last_error_code: null, last_error_category: null, updated_at: finishedAt }) });
    return { imported, duplicates, groups };
  } catch (error) {
    const finishedAt = new Date().toISOString(); const category = cardSyncErrorCategory(error); const code = String(error.message || 'sync_failed').slice(0, 120);
    await financeRest(`timefit_user_card_sync_runs?id=eq.${encodeURIComponent(runId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'failed', failed_count: 1, error_code: code, error_category: category, finished_at: finishedAt }) }).catch(() => {});
    const recentFailures = await financeRest(`timefit_user_card_sync_runs?connection_id=eq.${encodeURIComponent(connection.id)}&status=eq.failed&select=id&order=created_at.desc&limit=6`).catch(() => []);
    const retry = cardRetryPlan({ category, failureCount: Math.max(1, recentFailures.length), now: new Date(finishedAt) });
    await financeRest(`timefit_user_card_connections?id=eq.${encodeURIComponent(connection.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: retry.status, last_attempted_at: finishedAt, next_sync_at: retry.nextSyncAt, last_error_code: code, last_error_category: category, updated_at: finishedAt }) }).catch(() => {});
    throw error;
  }
}
