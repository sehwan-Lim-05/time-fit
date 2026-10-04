import { authorizeFinance, financeError, financeRest, financeServerConfigured, methodNotAllowed } from './_finance-server.js';
import { cardProvider } from './providers/card-provider.js';

const safeState = connection => ({
  provider: connection.provider,
  status: connection.status,
  last_error_code: connection.last_error_code,
  last_error_category: connection.last_error_category,
  next_sync_at: connection.next_sync_at,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  if (!financeServerConfigured()) return res.status(503).json({ ok: false, error: '금융 연결 서버 설정이 필요합니다.' });
  const { organizationId, connectionId, authentication } = req.body || {};
  const auth = await authorizeFinance(req, organizationId, { ownerOnly: true });
  if (!auth) return res.status(req.headers.authorization ? 403 : 401).json({ ok: false, error: '조직 소유자만 카드사 인증정보를 갱신할 수 있습니다.' });
  try {
    const rows = await financeRest(`timefit_user_card_connections?id=eq.${encodeURIComponent(connectionId)}&organization_id=eq.${encodeURIComponent(organizationId)}&select=*`);
    const connection = rows[0];
    if (!connection || connection.status === 'disconnected') return res.status(404).json({ ok: false, error: '갱신할 카드 연결을 찾지 못했습니다.' });
    const credential = await cardProvider(connection.provider).authenticate(authentication || {});
    const verifiedConnection = { ...connection, credential_reference_encrypted: credential.credentialReference };
    await cardProvider(connection.provider, verifiedConnection).listCards();
    const updatedAt = new Date().toISOString();
    const updated = await financeRest(`timefit_user_card_connections?id=eq.${encodeURIComponent(connection.id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ credential_reference_encrypted: credential.credentialReference, status: 'active', last_error_code: null, last_error_category: null, next_sync_at: updatedAt, updated_at: updatedAt }),
    });
    await financeRest('timefit_user_expense_audit_logs', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([{ organization_id: organizationId, entity_type: 'card_connection', entity_id: connection.id, action: 'credentials_refreshed', before_value: safeState(connection), after_value: safeState(updated[0]), actor_id: auth.user.id, source: 'manager_web' }]),
    });
    return res.status(200).json({ ok: true, connection: updated[0] });
  } catch (error) {
    if (/authentication_fields_required/.test(error.message)) return res.status(400).json({ ok: false, code: 'authentication_fields_required', error: '사업자번호, 카드사 코드와 인증 방식을 확인해 주세요.' });
    return financeError(res, error, '카드사 재인증을 완료하지 못했습니다. 입력 정보와 카드사 상태를 확인해 주세요.');
  }
}
