import { encryptSecret } from './_integration-crypto.js';

function headers() { return { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }; }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.INTEGRATION_ENCRYPTION_KEY) return res.status(503).json({ ok: false, error: 'Secure integration storage is unavailable' });
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const { organizationId, accessKey, accessSecret } = req.body || {};
  if (!token) return res.status(401).json({ ok: false, error: 'Sign in required' });
  if (!organizationId || !String(accessKey || '').trim() || !String(accessSecret || '').trim()) return res.status(400).json({ ok: false, error: 'Access Key and Secret are required' });
  try {
    const userResponse = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` } });
    if (!userResponse.ok) return res.status(401).json({ ok: false, error: 'Session expired' });
    const user = await userResponse.json();
    const membershipResponse = await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_memberships?organization_id=eq.${encodeURIComponent(organizationId)}&user_id=eq.${encodeURIComponent(user.id)}&role=eq.manager&select=organization_id`, { headers: headers() });
    if (!(await membershipResponse.json()).length) return res.status(403).json({ ok: false, error: 'Manager permission required' });
    const updateResponse = await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_tossplace_connections?organization_id=eq.${encodeURIComponent(organizationId)}`, { method: 'PATCH', headers: { ...headers(), Prefer: 'return=minimal' }, body: JSON.stringify({ credential_source: 'custom', encrypted_access_key: encryptSecret(accessKey.trim()), encrypted_access_secret: encryptSecret(accessSecret.trim()), last_error: null }) });
    if (!updateResponse.ok) throw new Error(`credentials_save_${updateResponse.status}`);
    return res.status(200).json({ ok: true });
  } catch (error) { console.error('Custom Toss credentials save failed', { message: error.message }); return res.status(502).json({ ok: false, error: 'Credentials could not be stored securely' }); }
}
