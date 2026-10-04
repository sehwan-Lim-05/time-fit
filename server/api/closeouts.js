import { authorizeFinance, financeError, financeRest, financeServerConfigured, methodNotAllowed, serviceHeaders } from './_finance-server.js';

async function userRpc(token, body) {
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/timefit_user_change_closeout_status`, { method: 'POST', headers: { ...serviceHeaders(), Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || `closeout_${response.status}`);
  return payload;
}

export default async function handler(req, res) {
  if (!['GET','POST'].includes(req.method)) return methodNotAllowed(res);
  if (!financeServerConfigured()) return res.status(503).json({ ok: false, error: '금융 처리 서버 설정이 필요합니다.' });
  const organizationId = req.method === 'GET' ? req.query?.organizationId : req.body?.organizationId;
  const auth = await authorizeFinance(req, organizationId, { ownerOnly: req.method === 'POST' });
  if (!auth) return res.status(req.headers.authorization ? 403 : 401).json({ ok: false, error: req.method === 'POST' ? '결산 확정과 재오픈은 사업장 소유자만 가능합니다.' : '관리자 인증이 필요합니다.' });
  try {
    if (req.method === 'GET') {
      const rows = await financeRest(`timefit_user_closeouts?organization_id=eq.${encodeURIComponent(organizationId)}&select=*,lines:timefit_user_closeout_lines(*)&order=period_start.desc,version.desc&limit=50`);
      const actorIds = [...new Set(rows.map(item => item.closed_by).filter(Boolean))];
      const accounts = actorIds.length ? await financeRest(`timefit_user_accounts?id=in.(${actorIds.map(encodeURIComponent).join(',')})&select=id,display_name`).catch(() => []) : [];
      const names = new Map(accounts.map(account => [account.id, account.display_name]));
      return res.status(200).json({ ok: true, closeouts: rows.map(item => ({ ...item, closed_by_name: names.get(item.closed_by) || null })) });
    }
    const action = String(req.body?.action || '');
    if (!['close','reopen'].includes(action)) return res.status(400).json({ ok: false, error: '결산 작업을 확인해 주세요.' });
    const result = await userRpc(auth.token, { p_closeout_id: req.body?.closeoutId, p_action: action, p_reason: req.body?.reason || null });
    return res.status(200).json({ ok: true, result });
  } catch (error) {
    const message = String(error.message || '');
    if (/closeout_not_ready/.test(message)) return res.status(409).json({ ok: false, error: '누락된 급여·증빙 검토를 완료한 준비 상태 결산만 확정할 수 있습니다.' });
    if (/reopen_reason_required/.test(message)) return res.status(400).json({ ok: false, error: '재오픈 사유를 5자 이상 입력해 주세요.' });
    return financeError(res, error, '결산 상태를 변경하지 못했습니다.');
  }
}
