function headers() { return { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' }; }

async function writeDelivery(payload) {
  return fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_settlement_deliveries`, { method: 'POST', headers: { ...headers(), Prefer: 'return=minimal' }, body: JSON.stringify(payload) });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ ok: false, error: 'Settlement service unavailable' });
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return res.status(503).json({ ok: false, error: '이메일 발송 환경이 아직 설정되지 않았습니다. 관리자에게 RESEND_API_KEY와 EMAIL_FROM 등록을 요청해 주세요.' });
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const { organizationId, settlementMonth, recipientEmail, summary = {} } = req.body || {};
  if (!token) return res.status(401).json({ ok: false, error: 'Sign in required' });
  if (!organizationId || !/^\d{4}-\d{2}-\d{2}$/.test(String(settlementMonth || '')) || !/^\S+@\S+\.\S+$/.test(String(recipientEmail || ''))) return res.status(400).json({ ok: false, error: '정산 월과 수신 이메일을 확인해 주세요.' });
  try {
    const userResponse = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` } });
    if (!userResponse.ok) return res.status(401).json({ ok: false, error: 'Session expired' });
    const user = await userResponse.json();
    const memberResponse = await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_memberships?organization_id=eq.${encodeURIComponent(organizationId)}&user_id=eq.${encodeURIComponent(user.id)}&role=eq.manager&select=organization_id`, { headers: headers() });
    if (!(await memberResponse.json()).length) return res.status(403).json({ ok: false, error: 'Manager permission required' });
    const amount = Number(summary.completedAmount || 0); const orders = Number(summary.completedOrders || 0); const documents = Number(summary.uploadedDocumentCount || 0);
    const monthLabel = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', timeZone: 'Asia/Seoul' }).format(new Date(`${settlementMonth}T00:00:00+09:00`));
    const emailResponse = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [recipientEmail], subject: `[TimeFit] ${monthLabel} 월말 정산 요약`, html: `<div style="font-family:Arial,sans-serif;color:#191f28"><h2>${monthLabel} 월말 정산 요약</h2><p>TimeFit에서 준비한 정산 현황입니다.</p><ul><li>완료 매출: <b>${Math.round(amount).toLocaleString('ko-KR')}원</b></li><li>완료 주문: <b>${orders.toLocaleString('ko-KR')}건</b></li><li>업로드 정산 증빙: <b>${documents.toLocaleString('ko-KR')}건</b></li></ul><p>세금계산서와 매출전표 원본은 TimeFit 관리자 화면에서 보안 권한으로 열람할 수 있습니다.</p></div>` }) });
    const result = await emailResponse.json().catch(() => ({}));
    if (!emailResponse.ok) { await writeDelivery({ organization_id: organizationId, settlement_month: settlementMonth, recipient_email: recipientEmail, status: 'failed', sales_amount: amount, completed_order_count: orders, document_count: documents, error_message: result.message || `email_${emailResponse.status}`, requested_by: user.id }); return res.status(502).json({ ok: false, error: '정산 이메일을 발송하지 못했습니다.' }); }
    await writeDelivery({ organization_id: organizationId, settlement_month: settlementMonth, recipient_email: recipientEmail, status: 'sent', sales_amount: amount, completed_order_count: orders, document_count: documents, provider_message_id: result.id || null, requested_by: user.id });
    return res.status(200).json({ ok: true, id: result.id || null });
  } catch (error) { console.error('Settlement email failed', { message: error.message }); return res.status(502).json({ ok: false, error: '정산 이메일을 발송하지 못했습니다.' }); }
}
