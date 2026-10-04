import { authorizeFinance, financeError, financeRest, financeServerConfigured, methodNotAllowed } from './_finance-server.js';
import { cardProvider } from './providers/card-provider.js';

export default async function handler(req, res) {
  if (!['GET','POST'].includes(req.method)) return methodNotAllowed(res);
  if (!financeServerConfigured()) return res.status(503).json({ ok: false, error: '금융 연결 서버 설정이 필요합니다.' });
  const organizationId = req.method === 'GET' ? req.query.organizationId : req.body?.organizationId;
  const auth = await authorizeFinance(req, organizationId, { ownerOnly: req.method === 'POST' });
  if (!auth) return res.status(req.headers.authorization ? 403 : 401).json({ ok: false, error: req.method === 'POST' ? '조직 소유자만 카드를 연결할 수 있습니다.' : '관리자 인증이 필요합니다.' });
  try {
    if (req.method === 'GET') {
      const connections = await financeRest(`timefit_user_card_connections?organization_id=eq.${encodeURIComponent(organizationId)}&select=id,provider,business_type,status,consent_version,consented_at,last_attempted_at,last_succeeded_at,next_sync_at,last_error_code,last_error_category,created_at&order=created_at.desc`);
      return res.status(200).json({ ok: true, connections });
    }
    const providerName = String(req.body?.provider || 'mock').trim().toLowerCase();
    if (providerName === 'hyphen' && (!process.env.HYPHEN_USER_ID || !process.env.HYPHEN_HKEY || !process.env.INTEGRATION_ENCRYPTION_KEY)) return res.status(503).json({ ok: false, code: 'provider_not_configured', error: '하이픈 연결정보와 암호화 키가 필요합니다.' });
    const provider = cardProvider(providerName);
    const credential = await provider.authenticate(req.body?.authentication || {});
    const created = await financeRest('timefit_user_card_connections', {
      method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{ organization_id: organizationId, provider: providerName, business_type: req.body?.businessType === 'sole_proprietor' ? 'sole_proprietor' : 'corporation', status: 'authenticating', credential_reference_encrypted: credential.credentialReference, consent_version: String(req.body?.consentVersion || '2026-09-10'), consented_by: auth.user.id, consented_at: new Date().toISOString(), created_by: auth.user.id }]),
    });
    return res.status(201).json({ ok: true, connection: created[0] });
  } catch (error) {
    if (error.status === 409) return res.status(409).json({ ok: false, error: '이미 진행 중인 카드 연결이 있습니다.' });
    return financeError(res, error, '카드 연결을 저장하지 못했습니다.');
  }
}
