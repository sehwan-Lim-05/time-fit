const headers = () => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' });
const kstDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());

async function sendEmail(delivery, employee) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM || !employee.user_id) return;
  const userResponse = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${employee.user_id}`, { headers: headers() });
  const user = await userResponse.json().catch(() => ({})); const email = user?.email || user?.user?.email;
  if (!email) return;
  const monthLabel = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', timeZone: 'Asia/Seoul' }).format(new Date(`${delivery.payroll_month}T00:00:00+09:00`));
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [email], subject: `[TimeFit] ${monthLabel} 급여 안내`, html: `<div style="font-family:Arial,sans-serif;color:#191f28"><h2>${monthLabel} 급여 안내</h2><p>${employee.display_name || '직원'}님, 급여일 안내입니다.</p><p>급여 상세와 근태 기록은 TimeFit에서 확인해 주세요.</p></div>` }) });
  const result = await response.json().catch(() => ({}));
  const patch = response.ok ? { status: 'sent', sent_at: new Date().toISOString(), provider_message_id: result.id || null, recipient_hint: email.replace(/(^.).*(@.*$)/, '$1***$2') } : { status: 'failed', error_message: result.message || `email_${response.status}` };
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_payroll_notification_deliveries?id=eq.${delivery.id}`, { method: 'PATCH', headers: { ...headers(), Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ ok: false, error: 'Missing server configuration' });
  const today = req.query.date || kstDate(); const day = Number(today.slice(-2)); const month = `${today.slice(0, 7)}-01`;
  try {
    const settingsResponse = await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_organization_settings?select=organization_id,payroll_notification_day,payroll_notification_email_enabled,payroll_notification_kakao_enabled,payroll_notification_push_enabled&payroll_notification_day=eq.${day}`, { headers: headers() });
    const settings = await settingsResponse.json(); let queued = 0;
    for (const setting of settings) {
      const staffResponse = await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_staff?organization_id=eq.${setting.organization_id}&select=id,display_name,user_id`, { headers: headers() });
      const staff = await staffResponse.json();
      for (const employee of staff) {
        const channels = [['email', setting.payroll_notification_email_enabled], ['kakao', setting.payroll_notification_kakao_enabled], ['push', setting.payroll_notification_push_enabled]];
        for (const [channel, enabled] of channels) if (enabled) {
          const payload = { organization_id: setting.organization_id, staff_id: employee.id, payroll_month: month, channel, status: channel === 'email' ? 'queued' : 'pending_configuration', recipient_hint: channel === 'email' ? '계정 이메일' : channel === 'kakao' ? '카카오 알림톡 채널 설정 필요' : '푸시 토큰 설정 필요' };
          const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_payroll_notification_deliveries?on_conflict=organization_id,staff_id,payroll_month,channel`, { method: 'POST', headers: { ...headers(), Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify(payload) });
          const [delivery] = await response.json().catch(() => []);
          if (response.ok) queued += 1;
          if (delivery && channel === 'email') await sendEmail(delivery, employee);
        }
      }
    }
    return res.status(200).json({ ok: true, date: today, queued });
  } catch (error) { return res.status(502).json({ ok: false, error: error.message || 'Payroll notification scheduling failed' }); }
}
