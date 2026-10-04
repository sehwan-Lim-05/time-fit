import { authorizeFinance, financeError, financeRest, financeServerConfigured, methodNotAllowed } from './_finance-server.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  if (!financeServerConfigured()) return res.status(503).json({ ok: false, error: '금융 연결 서버 설정이 필요합니다.' });
  const { organizationId, connectionId } = req.query || {};
  const auth = await authorizeFinance(req, organizationId, { ownerOnly: true });
  if (!auth) return res.status(req.headers.authorization ? 403 : 401).json({ ok: false, error: '조직 소유자만 연결 이력을 확인할 수 있습니다.' });
  try {
    const history = await financeRest(`timefit_user_expense_audit_logs?organization_id=eq.${encodeURIComponent(organizationId)}&entity_type=eq.card_connection&entity_id=eq.${encodeURIComponent(connectionId)}&select=id,action,before_value,after_value,source,created_at&order=created_at.desc&limit=20`);
    return res.status(200).json({ ok: true, history });
  } catch (error) { return financeError(res, error, '카드 연결 이력을 불러오지 못했습니다.'); }
}
