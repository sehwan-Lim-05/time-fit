function serverHeaders() {
  return { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.TOSSPLACE_MERCHANT_ID) return res.status(503).json({ ok: false, error: 'Toss Place server configuration is unavailable' });
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ ok: false, error: 'Sign in required' });
  const { organizationId, serviceId, serviceCode, displayName } = req.body || {};
  if (!organizationId || !String(serviceId || '').trim() || !String(serviceCode || '').trim()) return res.status(400).json({ ok: false, error: 'Connection information is required' });
  try {
    const userResponse = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` } });
    if (!userResponse.ok) return res.status(401).json({ ok: false, error: 'Session expired' });
    const user = await userResponse.json();
    const membershipResponse = await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_memberships?organization_id=eq.${encodeURIComponent(organizationId)}&user_id=eq.${encodeURIComponent(user.id)}&role=eq.manager&select=organization_id`, { headers: serverHeaders() });
    const memberships = membershipResponse.ok ? await membershipResponse.json() : [];
    if (!memberships.length) return res.status(403).json({ ok: false, error: 'Manager permission required' });
    const payload = { organization_id: organizationId, display_name: String(displayName || 'Toss Place').trim(), service_id: String(serviceId).trim(), service_code: String(serviceCode).trim().toUpperCase(), merchant_id: Number(process.env.TOSSPLACE_MERCHANT_ID), sync_enabled: true, connection_status: 'connected', last_error: null };
    const saveResponse = await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_tossplace_connections?on_conflict=organization_id`, { method: 'POST', headers: { ...serverHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify([payload]) });
    if (!saveResponse.ok) throw new Error(`connection_save_${saveResponse.status}`);
    return res.status(200).json({ ok: true, connection: await saveResponse.json() });
  } catch (error) {
    console.error('Toss Place bootstrap connection failed', { message: error.message });
    return res.status(502).json({ ok: false, error: 'Connection could not be saved' });
  }
}
