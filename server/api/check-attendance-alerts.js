export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ ok: false, error: 'Missing server configuration' });
  const headers = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' };
  const requestedOrganizationId = req.query.organizationId;
  let organizationIds = requestedOrganizationId ? [requestedOrganizationId] : [];
  if (!organizationIds.length) {
    const settings = await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_organization_settings?select=organization_id&absence_alert_enabled=eq.true`, { headers });
    if (!settings.ok) return res.status(502).json({ ok: false, error: 'Organization lookup failed' });
    organizationIds = [...new Set((await settings.json()).map(row => row.organization_id).filter(Boolean))];
  }
  const results = [];
  for (const organizationId of organizationIds) {
    const body = { p_organization_id: organizationId };
    if (req.query.workDate) body.p_work_date = req.query.workDate;
    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/timefit_user_scan_absence_alerts`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!response.ok) return res.status(502).json({ ok: false, error: 'Attendance alert scan failed', organizationId });
    results.push({ organizationId, ...(await response.json()) });
  }
  return res.status(200).json({ ok: true, scanned: results.length, results });
}
