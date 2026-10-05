import webpush from 'web-push';

const headers = () => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' });
export const allowedPushPath = value => /^\/#(?:notifications|schedule|attendance|requests|approvals)(?:\?.*)?$/.test(String(value || '')) ? String(value) : '/#notifications';
export const retryDelaySeconds = attempt => Math.min(3600, 30 * (2 ** Math.max(0, Number(attempt || 1) - 1)));

async function rest(path, options = {}) {
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, { ...options, headers: { ...headers(), ...options.headers } });
  if (!response.ok) throw new Error(`notification_rest_${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function patchDelivery(id, patch) {
  await rest(`timefit_user_notification_deliveries?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ...patch, lease_until: null, updated_at: new Date().toISOString() }) });
}

export default async function handler(req, res) {
  if (!['GET','POST'].includes(req.method)) return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  const required = ['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','WEB_PUSH_PUBLIC_KEY','WEB_PUSH_PRIVATE_KEY','WEB_PUSH_SUBJECT'];
  if (required.some(name => !process.env[name])) return res.status(503).json({ ok: false, error: 'Missing server configuration' });
  webpush.setVapidDetails(process.env.WEB_PUSH_SUBJECT, process.env.WEB_PUSH_PUBLIC_KEY, process.env.WEB_PUSH_PRIVATE_KEY);
  try {
    const claimed = await rest('rpc/timefit_user_claim_push_deliveries', { method: 'POST', body: JSON.stringify({ p_limit: 50 }) });
    const summary = { claimed: claimed.length, sent: 0, retried: 0, dead: 0 };
    for (const item of claimed) {
      try {
        await webpush.sendNotification({ endpoint: item.endpoint, keys: { p256dh: item.p256dh, auth: item.auth_secret } }, JSON.stringify({ title: item.title, body: item.body, tag: `timefit-${item.notification_id}`, deeplink: allowedPushPath(item.deeplink_path), notificationId: item.notification_id }), { TTL: 3600, urgency: 'normal' });
        await patchDelivery(item.delivery_id, { status: 'sent', sent_at: new Date().toISOString(), provider_status: 201, last_error: null }); summary.sent += 1;
      } catch (error) {
        const status = Number(error?.statusCode || 0); const permanent = status === 404 || status === 410;
        if (permanent) {
          await rest(`timefit_user_mobile_push_subscriptions?id=eq.${item.subscription_id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ revoked_at: new Date().toISOString(), revoked_reason: `provider_${status}`, updated_at: new Date().toISOString() }) });
        }
        const exhausted = Number(item.attempt_count || 1) >= 5;
        if (permanent || exhausted) { await patchDelivery(item.delivery_id, { status: 'dead', provider_status: status || null, last_error: String(error?.message || 'push_failed').slice(0,500) }); summary.dead += 1; }
        else { const next = new Date(Date.now() + retryDelaySeconds(item.attempt_count) * 1000).toISOString(); await patchDelivery(item.delivery_id, { status: 'retry_wait', available_at: next, provider_status: status || null, last_error: String(error?.message || 'push_failed').slice(0,500) }); summary.retried += 1; }
      }
    }
    return res.status(200).json({ ok: true, ...summary });
  } catch (error) { return res.status(502).json({ ok: false, error: error.message || 'Push delivery failed' }); }
}
