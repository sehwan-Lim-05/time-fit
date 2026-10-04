import { encryptSecret } from './_integration-crypto.js';

const serviceHeaders = () => ({
  apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
});

async function managerForStaff(token, staffId) {
  const userResponse = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` } });
  if (!userResponse.ok) throw Object.assign(new Error('Session expired'), { status: 401 });
  const user = await userResponse.json();
  const staffResponse = await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_staff?id=eq.${encodeURIComponent(staffId)}&select=id,organization_id`, { headers: serviceHeaders() });
  const [staff] = await staffResponse.json();
  if (!staff) throw Object.assign(new Error('직원 정보를 찾지 못했습니다.'), { status: 404 });
  const membershipResponse = await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_memberships?organization_id=eq.${staff.organization_id}&user_id=eq.${user.id}&role=eq.manager&select=organization_id`, { headers: serviceHeaders() });
  if (!(await membershipResponse.json()).length) throw Object.assign(new Error('관리자 권한이 필요합니다.'), { status: 403 });
  return { user, staff };
}

const digits = value => String(value || '').replace(/\D/g, '');
const residentMask = value => { const raw = digits(value); return raw.length === 13 ? `${raw.slice(0, 6)}-${raw.slice(6, 7)}******` : null; };

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ ok: false, error: 'Sensitive profile service unavailable' });
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const staffId = req.method === 'GET' ? req.query.staffId : req.body?.staffId;
  if (!token || !staffId) return res.status(400).json({ ok: false, error: '직원 정보를 확인해 주세요.' });
  try {
    const { user } = await managerForStaff(token, staffId);
    if (req.method === 'GET') {
      const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_staff_sensitive_profiles?staff_id=eq.${encodeURIComponent(staffId)}&select=bank_name,bank_account_last4,resident_registration_mask`, { headers: serviceHeaders() });
      const [profile] = await response.json();
      return res.status(200).json({ ok: true, profile: profile || null });
    }
    const bankAccount = digits(req.body?.bankAccount);
    const residentRegistrationNumber = digits(req.body?.residentRegistrationNumber);
    const bankName = String(req.body?.bankName || '').trim() || null;
    if (bankAccount && (bankAccount.length < 6 || bankAccount.length > 30)) return res.status(400).json({ ok: false, error: '계좌번호는 6~30자리 숫자로 입력해 주세요.' });
    if (residentRegistrationNumber && residentRegistrationNumber.length !== 13) return res.status(400).json({ ok: false, error: '주민등록번호는 13자리 숫자로 입력해 주세요.' });
    if ((bankName && !bankAccount) || (!bankName && bankAccount)) return res.status(400).json({ ok: false, error: '은행명과 계좌번호를 함께 입력해 주세요.' });
    const payload = {
      staff_id: staffId,
      bank_name: bankName,
      bank_account_last4: bankAccount ? bankAccount.slice(-4) : null,
      encrypted_bank_account: bankAccount ? encryptSecret(bankAccount) : null,
      resident_registration_mask: residentRegistrationNumber ? residentMask(residentRegistrationNumber) : null,
      encrypted_resident_registration_number: residentRegistrationNumber ? encryptSecret(residentRegistrationNumber) : null,
      updated_by: user.id,
    };
    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_staff_sensitive_profiles?on_conflict=staff_id`, { method: 'POST', headers: { ...serviceHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error('민감 정보 저장에 실패했습니다.');
    const [saved] = await response.json();
    return res.status(200).json({ ok: true, profile: { bank_name: saved.bank_name, bank_account_last4: saved.bank_account_last4, resident_registration_mask: saved.resident_registration_mask } });
  } catch (error) {
    return res.status(error.status || 500).json({ ok: false, error: error.message || '민감 정보 저장에 실패했습니다.' });
  }
}
