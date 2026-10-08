import { createClient } from '@supabase/supabase-js';
import { normalizePayrollDraftLine } from '../payrollDraftLine.js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabase = url && anonKey ? createClient(url, anonKey) : null;
let refreshSessionInFlight = null;

// A stalled network request must never leave the application behind an
// indefinite full-screen loader. Keep the timeout here so auth and workforce
// reads fail consistently and the UI can recover with a visible retry path.
const requestWithTimeout = (request, label = '요청') => Promise.race([
  request,
  new Promise((_, reject) => window.setTimeout(() => reject(new Error(`${label}_timeout`)), 15000)),
]);

// Supabase may report any of these while a persisted refresh token has already
// been invalidated (for example after logging out in another tab). Treat them
// as a signed-out state rather than leaving the app on an authentication error.
export const isAuthSessionError = error => /jwt|refresh token|session.*missing|invalid.*token|authsessionmissing|token.*not found/i.test(String(error?.message || error || ''));

const refreshSessionOnce = () => {
  if (!refreshSessionInFlight) {
    refreshSessionInFlight = requestWithTimeout(supabase.auth.refreshSession(), 'auth_refresh')
      .finally(() => { refreshSessionInFlight = null; });
  }
  return refreshSessionInFlight;
};

export async function recordQrAttendance(payload) {
  if (!supabase) throw new Error('Supabase 환경 변수가 설정되지 않았습니다.');
  const { data, error } = await supabase.functions.invoke('qr-attendance', { body: payload });
  if (error) {
    const detail = await error.context?.json?.().catch(() => null);
    throw new Error(detail?.error || error.message);
  }
  return data;
}

export async function startAttendanceQrSession(organizationId) {
  const { data, error } = await requireClient().rpc('timefit_user_start_attendance_qr', { p_organization_id: organizationId });
  if (error) throw error; return data;
}
export async function rotateAttendanceQrSession(sessionId) {
  const { data, error } = await requireClient().rpc('timefit_user_rotate_attendance_qr', { p_session_id: sessionId });
  if (error) throw error; return data;
}
export async function stopAttendanceQrSession(sessionId) {
  const { error } = await requireClient().rpc('timefit_user_stop_attendance_qr', { p_session_id: sessionId });
  if (error) throw error;
}

export async function getStaticAttendanceQr(organizationId) {
  const { data, error } = await requireClient().rpc('timefit_user_static_attendance_qr', { p_organization_id: organizationId, p_regenerate: false });
  if (error) throw error; return data;
}

export async function getAuthContext() {
  if (!supabase) return { session: null, profile: null, membership: null, invitation: null };
  let { data: { session } } = await requestWithTimeout(supabase.auth.getSession(), 'auth_session');
  // A restored tab can briefly hold an expired access token. Refresh it before
  // calling the authenticated context function so a stale JWT is never sent.
  // Multiple UI requests share this refresh operation to avoid rotating the
  // refresh token twice during a quick logout/login sequence.
  if (session?.expires_at && session.expires_at <= Math.floor(Date.now() / 1000) + 60) {
    const { data, error } = await refreshSessionOnce();
    if (error) throw error;
    session = data.session;
  }
  if (!session) return { session: null, profile: null, membership: null, invitation: null };
  const { data, error } = await requestWithTimeout(supabase.functions.invoke('get-user-context', { headers: { Authorization: `Bearer ${session.access_token}` } }), 'user_context');
  if (error) {
    const detail = await error.context?.json?.().catch(() => null);
    throw new Error(detail?.error || error.message);
  }
  return { session, profile: data.profile, membership: data.membership, managementAccount: data.managementAccount || null, isOrganizationOwner: Boolean(data.isOrganizationOwner), invitation: data.invitation };
}

export async function signUp({ email, password, displayName, accountType, organizationName }) {
  if (!supabase) throw new Error('Supabase 연결 정보가 없습니다.');
  const { error: signupError } = await supabase.functions.invoke('register-user', { body: { email, password, displayName, accountType, organizationName } });
  if (signupError) {
    const detail = await signupError.context?.json?.().catch(() => null);
    const message = detail?.error || signupError.message;
    if (/already.*registered|already exists|duplicate/i.test(message)) {
      throw new Error('이미 가입된 이메일입니다. 기존 계정으로 로그인해 주세요.');
    }
    if (/invalid_signup_input/i.test(message)) {
      throw new Error('이메일 형식과 8자 이상의 비밀번호를 확인해 주세요.');
    }
    if (/organization_name_required/i.test(message)) {
      throw new Error('사업장 이름을 입력해 주세요.');
    }
    throw new Error(`회원가입을 완료하지 못했습니다: ${message}`);
  }
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signIn({ email, password }) {
  if (!supabase) throw new Error('Supabase 연결 정보가 없습니다.');
  // Clear only this browser's persisted session first. This prevents an old,
  // already-revoked refresh token from racing the credentials just submitted.
  await supabase.auth.signOut({ scope: 'local' });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  if (!supabase) return;
  // Local sign-out is sufficient for this device and still succeeds if the
  // remote JWT has expired or was revoked. It is safer than failing logout.
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) throw error;
}

export async function ensureManagerOrganization(session) {
  if (!supabase || session.user.user_metadata?.role !== 'manager') return null;
  const name = session.user.user_metadata?.organization_name?.trim();
  if (!name) return null;
  const { data: organizationId, error } = await supabase.rpc('timefit_user_bootstrap_organization', { p_name: name });
  if (error) throw error;
  return { organization_id: organizationId, timefit_user_organizations: { id: organizationId, name } };
}

export async function inviteEmployeeByCode({ organizationId, employeeCode, department, jobTitle }) {
  if (!supabase) throw new Error('Supabase 연결 정보가 없습니다.');
  const { data, error } = await supabase.rpc('timefit_user_create_invitation', { p_organization_id: organizationId, p_employee_code: employeeCode, p_department: department || null, p_job_title: jobTitle || null });
  if (error) throw error;
  return data;
}

export async function acceptEmployeeInvitation(invitationId) {
  if (!supabase) throw new Error('Supabase 연결 정보가 없습니다.');
  const { data, error } = await supabase.rpc('timefit_user_accept_invitation', { p_invitation_id: invitationId });
  if (error) throw error;
  return data;
}

const requireClient = () => { if (!supabase) throw new Error('Supabase 연결 정보가 없습니다.'); return supabase; };

// Every page uses a stable order; a full page must never masquerade as a complete history.
async function allWorkforceRows(queryFactory) {
  const data = [];
  for (let offset = 0; offset < 100000; offset += 500) {
    const result = await queryFactory().range(offset, offset + 499);
    if (result.error) return result;
    data.push(...(result.data || []));
    if ((result.data || []).length < 500) return { data, error: null };
  }
  throw new Error('업무 기록이 너무 많습니다. 조회 범위를 확인해 주세요.');
}

export async function loadWorkforce(organizationId) {
  const client = requireClient();
  const context = await getAuthContext();
  const canViewPayroll = Boolean(context.isOrganizationOwner || context.managementAccount?.permissions?.includes('payroll.view'));
  const staffColumns = `id,user_id,display_name,department,category_id,job_title,joined_on,phone_e164,avatar_path,sort_order${canViewPayroll ? ',pay_type,hourly_wage,daily_wage,monthly_salary,annual_salary' : ''}`;
  const [staffResult, scheduleResult, leaveResult, attendanceResult, settingsResult, grantsResult, categoriesResult] = await requestWithTimeout(Promise.all([
    allWorkforceRows(() => client.from('timefit_user_staff').select(staffColumns).eq('organization_id', organizationId).order('sort_order').order('created_at').order('id')),
    allWorkforceRows(() => client.from('timefit_user_work_schedules').select('id,staff_id,work_date,starts_at,ends_at,break_minutes,break_paid,break_starts_at,break_ends_at,shift_name,is_day_off,status,approval_status,submitted_by,submitted_at,reviewed_by,reviewed_at,review_comment,updated_at').eq('organization_id', organizationId).order('work_date').order('id')),
    allWorkforceRows(() => client.from('timefit_user_leave_requests').select('id,staff_id,starts_on,ends_on,leave_type,amount,reason,status,review_comment,created_at').eq('organization_id', organizationId).order('created_at', { ascending: false }).order('id')),
    allWorkforceRows(() => client.from('timefit_user_attendance_records').select('id,staff_id,work_date,checked_in_at,checked_out_at,source,updated_at').eq('organization_id', organizationId).order('work_date', { ascending: false }).order('id')),
    client.from('timefit_user_organization_settings').select('*').eq('organization_id', organizationId).maybeSingle(),
    allWorkforceRows(() => client.from('timefit_user_leave_grants').select('id,staff_id,amount,reason,grant_type,attendance_record_id,granted_at,created_at').eq('organization_id', organizationId).order('granted_at', { ascending: false }).order('id')),
    allWorkforceRows(() => client.from('timefit_user_staff_categories').select('id,name,color,sort_order').eq('organization_id', organizationId).order('sort_order').order('name').order('id')),
  ]), 'workforce_load');
  for (const result of [staffResult, scheduleResult, leaveResult, attendanceResult, settingsResult, grantsResult, categoriesResult]) if (result.error) throw result.error;
  const userIds = (staffResult.data ?? []).map(item => item.user_id).filter(Boolean);
  const accountsResult = userIds.length
    ? await requestWithTimeout(client.from('timefit_user_accounts').select('id,display_name').in('id', userIds), 'workforce_accounts')
    : { data: [], error: null };
  if (accountsResult.error) throw accountsResult.error;
  const accounts = Object.fromEntries((accountsResult.data ?? []).map(item => [item.id, item]));
  const categories = categoriesResult.data ?? [];
  const categoryById = Object.fromEntries(categories.map(item => [item.id, item]));
  const staffRows = staffResult.data ?? [];
  const avatarPaths = staffRows.map(item => item.avatar_path).filter(Boolean);
  const signedAvatarUrls = avatarPaths.length
    ? await client.storage.from('timefit-staff-avatars').createSignedUrls(avatarPaths, 60 * 60)
    : { data: [], error: null };
  if (signedAvatarUrls.error) throw signedAvatarUrls.error;
  const avatarUrlByPath = Object.fromEntries((signedAvatarUrls.data ?? []).filter(item => item?.path && item?.signedUrl).map(item => [item.path, item.signedUrl]));
  return { staff: staffRows.map(item => ({ ...item, avatar_url: item.avatar_path ? avatarUrlByPath[item.avatar_path] || null : null, account: accounts[item.user_id], category: categoryById[item.category_id] || null })), schedules: scheduleResult.data ?? [], leaves: leaveResult.data ?? [], attendance: attendanceResult.data ?? [], settings: settingsResult.data, leaveGrants: grantsResult.data ?? [], categories };
}

export async function loadStaffCategories(organizationId) {
  const { data, error } = await requireClient().from('timefit_user_staff_categories').select('id,name,color,sort_order').eq('organization_id', organizationId).order('sort_order').order('name');
  if (error) throw error;
  return data ?? [];
}

export async function saveStaffCategory({ organizationId, id, name, color, sortOrder = 0 }) {
  const payload = { organization_id: organizationId, name: String(name || '').trim(), color, sort_order: Number(sortOrder) || 0 };
  if (!payload.name) throw new Error('category_name_required');
  const query = id ? requireClient().from('timefit_user_staff_categories').update(payload).eq('id', id) : requireClient().from('timefit_user_staff_categories').insert(payload);
  const { data, error } = await query.select().single();
  if (error) throw error;
  return data;
}

export async function deleteStaffCategory(id) {
  const { error } = await requireClient().from('timefit_user_staff_categories').delete().eq('id', id);
  if (error) throw error;
}

export async function saveStaffOrder(staffIds) {
  const results = await Promise.all(staffIds.map((id, index) => requireClient().from('timefit_user_staff').update({ sort_order: index }).eq('id', id)));
  const failed = results.find(result => result.error);
  if (failed) throw failed.error;
}

function throwWorkScheduleError(error) {
  if (!error) return;
  if (error.code === '23P01' || error.code === '23505' || error.message?.includes('schedule_time_conflict')) {
    throw new Error('schedule_time_conflict');
  }
  throw error;
}

export async function saveWorkSchedule({ scheduleId = null, organizationId, staffId, workDate, startsAt, endsAt, shiftName, breakMinutes = 0, breakStartsAt = null, breakEndsAt = null }) {
  const client = requireClient();
  const isDayOff = !startsAt || !endsAt;
  const payload = { organization_id: organizationId, staff_id: staffId, work_date: workDate, starts_at: isDayOff ? null : startsAt, ends_at: isDayOff ? null : endsAt, break_minutes: isDayOff ? 0 : Number(breakMinutes) || 0, break_starts_at: isDayOff ? null : breakStartsAt || null, break_ends_at: isDayOff ? null : breakEndsAt || null, shift_name: shiftName || (isDayOff ? '휴무' : '일반 근무'), is_day_off: isDayOff };
  const request = scheduleId
    ? client.from('timefit_user_work_schedules').update(payload).eq('id', scheduleId).eq('organization_id', organizationId)
    : client.from('timefit_user_work_schedules').insert({ ...payload, created_by: (await client.auth.getUser()).data.user?.id });
  const { data, error } = await request.select().single();
  if (error) throwWorkScheduleError(error); return data;
}

export async function saveWorkSchedulesBulk({ organizationId, staffIds, workDates, startsAt, endsAt, shiftName, breakMinutes = 0, breakStartsAt = null, breakEndsAt = null }) {
  const client = requireClient();
  const userId = (await client.auth.getUser()).data.user?.id;
  const isDayOff = !startsAt || !endsAt;
  const rows = staffIds.flatMap(staffId => workDates.map(workDate => ({
    organization_id: organizationId, staff_id: staffId, work_date: workDate,
    starts_at: isDayOff ? null : startsAt, ends_at: isDayOff ? null : endsAt,
    break_minutes: isDayOff ? 0 : Number(breakMinutes) || 0, break_starts_at: isDayOff ? null : breakStartsAt || null, break_ends_at: isDayOff ? null : breakEndsAt || null, shift_name: shiftName || (isDayOff ? '휴무' : '일반 근무'),
    is_day_off: isDayOff, created_by: userId,
  })));
  if (!rows.length) throw new Error('bulk_schedule_selection_required');
  const { data, error } = await client.from('timefit_user_work_schedules').insert(rows).select();
  if (error) throwWorkScheduleError(error);
  return { count: data?.length || rows.length };
}

export async function deleteWorkSchedule(scheduleId) {
  const { error } = await requireClient().from('timefit_user_work_schedules').delete().eq('id', scheduleId);
  if (error) throw error;
}

export async function reviewWorkSchedule({ scheduleId, decision, comment = '' }) {
  const { data, error } = await requireClient().rpc('timefit_user_review_schedule', { p_schedule_id: scheduleId, p_decision: decision, p_comment: comment || null });
  if (error) throw error; return data;
}

export async function createManagementAccount(payload) {
  const client = requireClient();
  const { data, error } = await client.functions.invoke('create-management-account', { body: payload });
  if (error) { const detail = await error.context?.json?.().catch(() => null); throw new Error(detail?.error || error.message); }
  return data;
}

export async function manageManagementAccount(payload) {
  const client = requireClient();
  const { data, error } = await client.functions.invoke('manage-management-account', { body: payload });
  if (error) { const detail = await error.context?.json?.().catch(() => null); throw new Error(detail?.error || error.message); }
  return data;
}

export async function loadManagementAccounts(organizationId) {
  const client = requireClient();
  const { data, error } = await client.from('timefit_user_management_accounts').select('id,user_id,staff_id,login_id,role_code,status,force_password_change,created_at,timefit_user_management_permissions(permission_code,allowed),timefit_user_management_scopes(category_id),timefit_user_management_cost_center_scopes(cost_center_id)').eq('organization_id', organizationId).order('created_at', { ascending: false });
  if (error) throw error; return data || [];
}

export async function createLeaveRequest({ organizationId, staffId, startsOn, endsOn, leaveType, amount, reason }) {
  const { data, error } = await requireClient().rpc('timefit_user_submit_leave_request', { p_organization_id: organizationId, p_staff_id: staffId, p_starts_on: startsOn, p_ends_on: endsOn, p_leave_type: leaveType, p_reason: reason || null });
  if (error) throw error; return data;
}

export async function reviewLeaveRequest({ id, status, comment }) {
  const client = requireClient(); const userId = (await client.auth.getUser()).data.user?.id;
  const { data, error } = await client.from('timefit_user_leave_requests').update({ status, review_comment: comment || null, reviewed_by: userId, reviewed_at: new Date().toISOString() }).eq('id', id).select().single();
  if (error) throw error; return data;
}

export async function getOrganizationSettings(organizationId) {
  const { data, error } = await requireClient().from('timefit_user_organization_settings').select('*').eq('organization_id', organizationId).maybeSingle();
  if (error) throw error; return data;
}
export async function saveOrganizationSettings(settings) {
  const { data, error } = await requireClient().from('timefit_user_organization_settings').upsert(settings, { onConflict: 'organization_id' }).select().single();
  if (error) throw error; return data;
}
export async function getTossPlaceConnection(organizationId) {
  const { data, error } = await requireClient().from('timefit_user_tossplace_connections').select('id,organization_id,display_name,service_id,service_code,merchant_id,sync_enabled,connection_status,credential_source,last_synced_at,last_error,created_at,updated_at').eq('organization_id', organizationId).maybeSingle();
  if (error) throw error; return data;
}
export async function saveTossPlaceConnection(connection) {
  const payload = {
    ...connection,
    service_id: String(connection.service_id || '').trim(),
    service_code: String(connection.service_code || '').trim().toUpperCase(),
    merchant_id: connection.merchant_id ? Number(connection.merchant_id) : null,
    connection_status: connection.merchant_id ? 'connected' : 'pending',
  };
  const { data, error } = await requireClient().from('timefit_user_tossplace_connections').upsert(payload, { onConflict: 'organization_id' }).select().single();
  if (error) throw error; return data;
}
export async function bootstrapTossPlaceConnection(connection) {
  const client = requireClient(); const { data: { session } } = await client.auth.getSession();
  if (!session?.access_token) throw new Error('로그인이 필요합니다.');
  const response = await fetch('/api/tossplace-bootstrap-connection', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify(connection) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Toss Place 계정을 연결하지 못했습니다.');
  return body.connection?.[0] || body.connection;
}
export async function saveCustomTossPlaceCredentials({ organizationId, accessKey, accessSecret }) {
  const client = requireClient(); const { data: { session } } = await client.auth.getSession();
  if (!session?.access_token) throw new Error('로그인이 필요합니다.');
  const response = await fetch('/api/tossplace-custom-credentials', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ organizationId, accessKey, accessSecret }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || '인증 정보를 저장하지 못했습니다.');
}
// Sales is shown often while a manager moves between menu pages. Keep a
// short-lived, per-organization cache in memory so a return navigation never
// waits for the server before the existing numbers are visible.
const SALES_DASHBOARD_CACHE_TTL = 3 * 60 * 1000;
const salesDashboardCache = new Map();
const salesDashboardCacheKey = (organizationId, filters = {}) => `${organizationId}:${filters.from || ''}:${filters.to || ''}`;
const salesDashboardStorageKey = key => `timefit:sales-dashboard:${key}`;

const rememberSalesDashboard = (key, entry) => {
  salesDashboardCache.set(key, entry);
  try { window.sessionStorage.setItem(salesDashboardStorageKey(key), JSON.stringify(entry)); } catch { /* Browser storage is an optional speed-up. */ }
};

export function getCachedOrganizationSalesDashboard(organizationId, filters = {}) {
  if (!organizationId) return null;
  const key = salesDashboardCacheKey(organizationId, filters);
  let entry = salesDashboardCache.get(key);
  if (!entry) {
    try {
      const stored = window.sessionStorage.getItem(salesDashboardStorageKey(key));
      entry = stored ? JSON.parse(stored) : null;
      if (entry?.data && Number.isFinite(entry.cachedAt)) salesDashboardCache.set(key, entry);
    } catch { entry = null; }
  }
  if (!entry) return null;
  const age = Date.now() - entry.cachedAt;
  return { data: entry.data, cachedAt: entry.cachedAt, age, isFresh: age < SALES_DASHBOARD_CACHE_TTL };
}

export async function loadOrganizationSalesDashboard(organizationId, filters = {}, { force = false } = {}) {
  const cacheKey = salesDashboardCacheKey(organizationId, filters);
  const cached = getCachedOrganizationSalesDashboard(organizationId, filters);
  if (!force && cached?.isFresh) return cached.data;
  const client = requireClient(); const { data: { session } } = await client.auth.getSession();
  if (!session?.access_token) throw new Error('로그인이 필요합니다.');
  const query = new URLSearchParams({ organizationId, ...(filters.from ? { from: filters.from } : {}), ...(filters.to ? { to: filters.to } : {}) });
  const response = await fetch(`/api/organization-sales-dashboard?${query}`, { headers: { Authorization: `Bearer ${session.access_token}` } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || '매출 데이터를 불러오지 못했습니다.');
  rememberSalesDashboard(cacheKey, { data: body, cachedAt: Date.now() });
  return body;
}
export async function syncOrganizationSales(organizationId, options = {}) {
  const client = requireClient(); const { data: { session } } = await client.auth.getSession();
  if (!session?.access_token) throw new Error('로그인이 필요합니다.');
  const response = await fetch('/api/sync-sales', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ organizationId, ...options }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || '매출 동기화를 완료하지 못했습니다.');
  return body;
}
export async function sendSettlementEmail(payload) {
  const client = requireClient(); const { data: { session } } = await client.auth.getSession();
  if (!session?.access_token) throw new Error('로그인이 필요합니다.');
  const response = await fetch('/api/send-settlement-email', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify(payload) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || '정산 이메일을 발송하지 못했습니다.');
  return body;
}
export async function loadPayrollWorkspace(organizationId, settlementMonth) {
  const client = requireClient(); const month = `${settlementMonth}-01`;
  const [contractsResult, draftsResult] = await Promise.all([
    client.from('timefit_user_payroll_contracts').select('*').eq('organization_id', organizationId).order('effective_from', { ascending: false }),
    client.from('timefit_user_payroll_drafts').select('*').eq('organization_id', organizationId).eq('settlement_month', month).maybeSingle(),
  ]);
  if (contractsResult.error) throw contractsResult.error;
  if (draftsResult.error) throw draftsResult.error;
  const linesResult = draftsResult.data ? await client.from('timefit_user_payroll_draft_lines').select('*').eq('payroll_draft_id', draftsResult.data.id).order('created_at') : { data: [], error: null };
  if (linesResult.error) throw linesResult.error;
  return { contracts: contractsResult.data || [], draft: draftsResult.data || null, lines: linesResult.data || [] };
}
export async function savePayrollContract(contract) {
  const client = requireClient(); const userId = (await client.auth.getUser()).data.user?.id;
  const { data, error } = await client.from('timefit_user_payroll_contracts').insert({ ...contract, created_by: userId }).select().single();
  if (error) throw error; return data;
}
export async function savePayrollDraft({ organizationId, settlementMonth, status = 'draft', lines }) {
  const normalizedLines = lines.map(normalizePayrollDraftLine);
  const client = requireClient(); const userId = (await client.auth.getUser()).data.user?.id; const month = `${settlementMonth}-01`;
  const { data: draft, error: draftError } = await client.from('timefit_user_payroll_drafts').upsert({ organization_id: organizationId, settlement_month: month, status, updated_by: userId, created_by: userId, updated_at: new Date().toISOString() }, { onConflict: 'organization_id,settlement_month' }).select().single();
  if (draftError) throw draftError;
  const { error: deleteError } = await client.from('timefit_user_payroll_draft_lines').delete().eq('payroll_draft_id', draft.id);
  if (deleteError) throw deleteError;
  if (normalizedLines.length) { const { error: linesError } = await client.from('timefit_user_payroll_draft_lines').insert(normalizedLines.map(line => ({ ...line, payroll_draft_id: draft.id }))); if (linesError) throw linesError; }
  return draft;
}
export async function loadFeedbackItems(organizationId) {
  const { data, error } = await requireClient().from('timefit_user_feedback_items').select('*').eq('organization_id', organizationId).order('created_at', { ascending: false });
  if (error) throw error; return data || [];
}
export async function createFeedbackItem(item) {
  const client = requireClient(); const userId = (await client.auth.getUser()).data.user?.id;
  const { data, error } = await client.from('timefit_user_feedback_items').insert({ ...item, source: 'internal', created_by: userId }).select().single();
  if (error) throw error; return data;
}
export async function updateFeedbackItem(id, patch) {
  const { data, error } = await requireClient().from('timefit_user_feedback_items').update(patch).eq('id', id).select().single();
  if (error) throw error; return data;
}
export async function importFeedbackItems(items) {
  if (!items.length) return { count: 0 };
  const { data, error } = await requireClient().from('timefit_user_feedback_items').upsert(items, { onConflict: 'organization_id,source,external_id' }).select('id');
  if (error) throw error; return { count: data?.length || items.length };
}
export async function loadOperationalAlerts(organizationId) {
  const { data, error } = await requireClient().from('timefit_user_operational_alerts').select('*, timefit_user_staff(display_name, account:timefit_user_accounts(display_name))').eq('organization_id', organizationId).order('scheduled_for', { ascending: false }).limit(20);
  if (error) throw error; return data || [];
}
export async function markOperationalAlertRead(id) {
  const { data, error } = await requireClient().from('timefit_user_operational_alerts').update({ status: 'read', read_at: new Date().toISOString() }).eq('id', id).select().single();
  if (error) throw error; return data;
}
export async function loadFinanceDocuments(organizationId) {
  const { data, error } = await requireClient().from('timefit_user_finance_documents').select('*').eq('organization_id', organizationId).order('created_at', { ascending: false });
  if (error) throw error; return data || [];
}
export async function uploadFinanceDocument({ organizationId, documentType, title, file, documentDate, memo, staffId = null, submissionReason = null }) {
  const client = requireClient(); const userId = (await client.auth.getUser()).data.user?.id;
  if (!file?.size) throw new Error('업로드할 파일을 선택해 주세요.');
  if (file.size > 20 * 1024 * 1024) throw new Error('파일은 20MB 이하만 업로드할 수 있어요.');
  const isReceipt = documentType === 'receipt' || file.type?.startsWith('image/');
  let contentSha256 = null;
  if (isReceipt && globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    contentSha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    const { data: duplicate, error: duplicateError } = await client.from('timefit_user_finance_documents').select('id,title,created_at').eq('organization_id', organizationId).eq('content_sha256', contentSha256).maybeSingle();
    if (duplicateError) throw duplicateError;
    if (duplicate) throw new Error(`이미 등록된 영수증입니다: ${duplicate.title}`);
  }
  const safeName = file.name.replace(/[^a-zA-Z0-9가-힣._-]/g, '_'); const path = `${organizationId}/${userId || 'manager'}/${Date.now()}-${safeName}`;
  const { error: uploadError } = await client.storage.from('timefit-finance-documents').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
  if (uploadError) throw uploadError;
  const { data, error } = await client.from('timefit_user_finance_documents').insert({ organization_id: organizationId, document_type: isReceipt ? 'receipt' : documentType, title, file_name: file.name, storage_path: path, mime_type: file.type || null, file_size: file.size, content_sha256: contentSha256, document_date: documentDate || null, memo: memo || null, uploaded_by: userId, submitted_by_staff_id: staffId, submission_reason: submissionReason }).select().single();
  if (error) { await client.storage.from('timefit-finance-documents').remove([path]); throw error; }
  return data;
}
const sha256File = async file => {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
};

export async function loadCostCenters(organizationId) {
  const { data, error } = await requireClient().from('timefit_user_cost_centers').select('id,parent_id,center_type,name,code,staff_category_id,status,sort_order').eq('organization_id', organizationId).eq('status', 'active').order('sort_order').order('name');
  if (error) throw error; return data || [];
}
export async function saveCostCenter({ id, organizationId, parentId, centerType, name, code, sortOrder = 0 }) {
  const client = requireClient();
  const payload = { organization_id: organizationId, parent_id: centerType === 'section' ? parentId : null, center_type: centerType, name: String(name || '').trim(), code: String(code || '').trim() || null, sort_order: Number(sortOrder || 0), status: 'active', updated_at: new Date().toISOString() };
  if (!payload.name || !['department','section'].includes(centerType) || (centerType === 'section' && !parentId)) throw new Error('부서·섹션 정보를 확인해 주세요.');
  const query = id ? client.from('timefit_user_cost_centers').update(payload).eq('id', id) : client.from('timefit_user_cost_centers').insert(payload);
  const { data, error } = await query.select().single(); if (error) throw error; return data;
}
export async function archiveCostCenter(id) {
  const { data, error } = await requireClient().from('timefit_user_cost_centers').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('id', id).select().single();
  if (error) throw error; return data;
}

export async function createReceiptSubmission({ organizationId, files, costCenterId, paymentMethod, staffId, submissionReason, source = 'employee_web' }) {
  const client = requireClient(); const userId = (await client.auth.getUser()).data.user?.id;
  const selected = Array.from(files || []).filter(Boolean);
  if (!selected.length) throw new Error('촬영한 영수증을 선택해 주세요.');
  if (selected.length > 20) throw new Error('영수증은 한 번에 20장까지 올릴 수 있어요.');
  if (selected.some(file => !['image/jpeg','image/png','image/webp'].includes(String(file.type || '').toLowerCase()))) throw new Error('OCR 처리 전 JPG, PNG 또는 WebP 이미지가 필요합니다.');
  if (selected.some(file => file.size > 7 * 1024 * 1024) || selected.reduce((sum, file) => sum + file.size, 0) > 60 * 1024 * 1024) throw new Error('OCR용 이미지 한 장은 7MB, 전체는 60MB 이하만 올릴 수 있어요.');
  if (!costCenterId) throw new Error('영수증을 사용할 부서·섹션을 선택해 주세요.');
  const hashes = await Promise.all(selected.map(sha256File));
  let contentSha256 = hashes.length === 1 ? hashes[0] : null;
  if (hashes.every(Boolean) && globalThis.crypto?.subtle) {
    const combined = new TextEncoder().encode(hashes.join('|'));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', combined);
    contentSha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  }
  if (contentSha256) {
    const { data: duplicate, error: duplicateError } = await client.from('timefit_user_finance_documents').select('id,title,created_at').eq('organization_id', organizationId).eq('content_sha256', contentSha256).maybeSingle();
    if (duplicateError) throw duplicateError;
    if (duplicate) { const error = new Error('이미 등록된 영수증입니다. 기존 제출 내역을 확인해 주세요.'); error.code = 'duplicate_receipt'; error.documentId = duplicate.id; throw error; }
  }
  const sessionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const paths = selected.map((file, index) => `${organizationId}/${userId || 'employee'}/${sessionId}/${String(index + 1).padStart(2, '0')}-${file.name.replace(/[^a-zA-Z0-9가-힣._-]/g, '_')}`);
  const uploaded = [];
  try {
    for (let index = 0; index < selected.length; index += 1) {
      const { error } = await client.storage.from('timefit-finance-documents').upload(paths[index], selected[index], { contentType: selected[index].type || 'application/octet-stream', upsert: false });
      if (error) throw error; uploaded.push(paths[index]);
    }
    const now = new Date();
    const { data: document, error: documentError } = await client.from('timefit_user_finance_documents').insert({
      organization_id: organizationId, document_type: 'receipt', title: `${now.toLocaleDateString('ko-KR')} 영수증`,
      file_name: selected[0].name, storage_path: paths[0], mime_type: selected[0].type || null,
      file_size: selected.reduce((sum, file) => sum + file.size, 0), content_sha256: contentSha256,
      uploaded_by: userId, submitted_by_staff_id: staffId || null, submission_reason: submissionReason || null,
      cost_center_id: costCenterId, payment_method: paymentMethod || null, review_status: 'submitted',
      processing_status: 'uploaded', submitted_at: now.toISOString(), page_count: selected.length,
      capture_metadata: { uploadSessionId: sessionId, source },
    }).select().single();
    if (documentError) throw documentError;
    const { error: pagesError } = await client.from('timefit_user_finance_document_pages').insert(selected.map((file, index) => ({
      organization_id: organizationId, document_id: document.id, page_number: index + 1, storage_path: paths[index],
      mime_type: file.type || null, file_size: file.size, content_sha256: hashes[index],
    })));
    if (pagesError) { await client.from('timefit_user_finance_documents').delete().eq('id', document.id); throw pagesError; }
    return document;
  } catch (error) {
    if (uploaded.length) await client.storage.from('timefit-finance-documents').remove(uploaded).catch(() => {});
    throw error;
  }
}
export async function uploadReceiptToGoogleDrive({ organizationId, file }) {
  if (!organizationId || !file?.size) throw new Error('영수증 파일을 선택해 주세요.');
  const body = new FormData(); body.set('organizationId', organizationId); body.set('file', file, file.name);
  const { data, error } = await requireClient().functions.invoke('upload-receipt-drive', { body });
  if (error) {
    const detail = await error.context?.json?.().catch(() => null);
    throw new Error(detail?.error || error.message || 'Google Drive 업로드에 실패했습니다.');
  }
  if (!data?.file?.webViewLink) throw new Error('Google Drive 파일 URL을 받지 못했습니다.');
  const uploaded = { ...data.file, createdAt: data.file.createdTime || new Date().toISOString() };
  if (typeof window !== 'undefined') {
    const key = `timefit:drive-receipts:${organizationId}`;
    let current = [];
    try { current = JSON.parse(window.localStorage.getItem(key) || '[]'); } catch { current = []; }
    window.localStorage.setItem(key, JSON.stringify([uploaded, ...current.filter(item => item.id !== uploaded.id)].slice(0, 50)));
  }
  return uploaded;
}
export async function loadDriveReceiptUploads(organizationId) {
  if (!organizationId || typeof window === 'undefined') return [];
  try { return JSON.parse(window.localStorage.getItem(`timefit:drive-receipts:${organizationId}`) || '[]'); }
  catch { return []; }
}
export async function loadMyReceiptDocuments(organizationId) {
  const client = requireClient(); const userId = (await client.auth.getUser()).data.user?.id;
  const { data, error } = await client.from('timefit_user_finance_documents').select('id,title,file_name,processing_status,review_status,processing_error,extracted_data,cost_center_id,payment_method,change_request_reason,page_count,created_at').eq('organization_id', organizationId).eq('document_type', 'receipt').eq('uploaded_by', userId).order('created_at', { ascending: false }).limit(40);
  if (error) throw error; return data || [];
}
export async function loadMyExpenseReceiptReminders(organizationId, staffId) {
  const { data, error } = await requireClient().from('timefit_user_expense_receipt_reminders').select('id,message,status,reminder_number,created_at,transaction_group_id').eq('organization_id', organizationId).eq('staff_id', staffId).in('status', ['sent','read']).order('created_at', { ascending: false }).limit(20);
  if (error) throw error; return data || [];
}
export async function markExpenseReceiptReminderRead(id) {
  const { data, error } = await requireClient().rpc('timefit_user_mark_expense_receipt_reminder_read', { p_reminder_id: id });
  if (error) throw error; return data;
}
export async function runExpenseReminderScan(organizationId) {
  return cardConnectionRequest('expense-reminder-worker', { method: 'POST', body: { organizationId } });
}
export async function loadExpenseLedger(organizationId, filters = {}) {
  return cardConnectionRequest('expenses', { query: { organizationId, ...filters } });
}
export async function loadExpenseDetail(organizationId, expenseId) {
  return cardConnectionRequest('expense-detail', { query: { organizationId, expenseId } });
}
export async function createManualExpense(input) {
  return cardConnectionRequest('expenses', { method: 'POST', body: input });
}
export async function processReceiptDocument({ organizationId, documentId }) {
  const payload = await cardConnectionRequest('receipt-process', { method: 'POST', body: { organizationId, documentId, action: 'enqueue' } });
  return payload;
}
export async function loadReceiptSubmission({ organizationId, documentId }) {
  return cardConnectionRequest('receipt-process', { query: { organizationId, documentId } });
}
export async function confirmReceiptSubmission({ organizationId, documentId, patch }) {
  return cardConnectionRequest('receipt-process', { method: 'PATCH', body: { organizationId, documentId, action: 'submitter_confirm', patch } });
}
export async function loadExpenseReviewQueue(organizationId, status = 'attention', costCenterId = '') {
  const payload = await cardConnectionRequest('expense-review', { query: { organizationId, status, ...(costCenterId ? { costCenterId } : {}) } });
  return payload.documents || [];
}
export async function reviewExpenseMatch({ organizationId, matchId, action }) {
  const payload = await cardConnectionRequest('expense-review', { method: 'POST', body: { organizationId, matchId, action } });
  return payload.result;
}
export async function bulkConfirmExpenseMatches({ organizationId, matchIds }) {
  return cardConnectionRequest('expense-review', { method: 'POST', body: { organizationId, action: 'bulk_confirm', matchIds } });
}
export async function requestReceiptChange({ organizationId, documentId, reason }) {
  const payload = await cardConnectionRequest('expense-review', { method: 'POST', body: { organizationId, documentId, reason, action: 'request_change' } });
  return payload.result;
}
export async function approveReceiptExpense({ organizationId, documentId, expenseId }) {
  const payload = await cardConnectionRequest('expense-review', { method: 'POST', body: { organizationId, documentId, expenseId, action: 'approve_receipt' } });
  return payload.result;
}
export async function updateExpenseDraft({ organizationId, expenseId, transactionDate, totalAmount, merchantName, merchantBusinessNumber, category, reason, rememberRule }) {
  const payload = await cardConnectionRequest('expense-review', { method: 'PATCH', body: { organizationId, expenseId, transactionDate, totalAmount, merchantName, merchantBusinessNumber, category, reason, rememberRule } });
  return payload.expense;
}
export async function excludeExpenseDraft({ organizationId, expenseId }) {
  const payload = await cardConnectionRequest('expense-review', { method: 'POST', body: { organizationId, expenseId, action: 'exclude' } });
  return payload.result;
}
export async function loadFinanceReport({ organizationId, periodType, from, to }) {
  const payload = await cardConnectionRequest('finance-report', { query: { organizationId, periodType, from, to } });
  return payload.report;
}
export async function createFinanceCloseout({ organizationId, periodType, from, to }) {
  const payload = await cardConnectionRequest('finance-report', { method: 'POST', body: { organizationId, periodType, from, to } });
  return payload;
}
export async function loadFinanceCloseouts(organizationId) {
  const payload = await cardConnectionRequest('closeouts', { query: { organizationId } });
  return payload.closeouts || [];
}
export async function changeFinanceCloseout({ organizationId, closeoutId, action, reason }) {
  const payload = await cardConnectionRequest('closeouts', { method: 'POST', body: { organizationId, closeoutId, action, reason } });
  return payload.result;
}
export async function loadExpenseExceptions(organizationId) {
  const payload = await cardConnectionRequest('expense-exceptions', { query: { organizationId } });
  return { items: payload.items || [], summary: payload.summary || {} };
}
export async function openFinanceDocument(path) {
  const { data, error } = await requireClient().storage.from('timefit-finance-documents').createSignedUrl(path, 60);
  if (error) throw error; return data.signedUrl;
}
export async function deleteFinanceDocument(document) {
  const client = requireClient(); const { error } = await client.from('timefit_user_finance_documents').delete().eq('id', document.id);
  if (error) throw error; await client.storage.from('timefit-finance-documents').remove([document.storage_path]);
}
export async function loadCorporateCards(organizationId) {
  const { data, error } = await requireClient().from('timefit_user_corporate_cards').select('*, holder:timefit_user_staff(display_name)').eq('organization_id', organizationId).is('archived_at', null).order('created_at', { ascending: false });
  if (error) throw error; return data || [];
}
export async function createCorporateCard({ organizationId, issuer, nickname, last4, holderStaffId }) {
  const client = requireClient(); const userId = (await client.auth.getUser()).data.user?.id;
  const normalizedLast4 = String(last4 || '').replace(/\D/g, '');
  if (normalizedLast4.length !== 4) throw new Error('카드번호 끝 4자리를 확인해 주세요.');
  const providerCardId = `manual:${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  const { data, error } = await client.from('timefit_user_corporate_cards').insert({ organization_id: organizationId, issuer: String(issuer || '').trim(), nickname: String(nickname || '').trim(), last4: normalizedLast4, holder_staff_id: holderStaffId || null, provider: 'manual', provider_card_id: providerCardId, created_by: userId }).select('*, holder:timefit_user_staff(display_name)').single();
  if (error) throw error; return data;
}
export async function updateCorporateCard(id, patch) {
  const { data, error } = await requireClient().from('timefit_user_corporate_cards').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select('*, holder:timefit_user_staff(display_name)').single();
  if (error) throw error; return data;
}
export async function disconnectCorporateCard(id) {
  const { data, error } = await requireClient().rpc('timefit_user_disconnect_corporate_card', { p_card_id: id });
  if (error) throw error; return data;
}

async function cardConnectionRequest(path, { method = 'GET', query, body } = {}) {
  const client = requireClient();
  const { data: { session } } = await client.auth.getSession();
  if (!session?.access_token) throw new Error('로그인이 필요합니다.');
  const search = query ? `?${new URLSearchParams(query).toString()}` : '';
  const response = await requestWithTimeout(fetch(`/api/${path}${search}`, {
    method,
    headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }), 'card_connection');
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || '카드사 연결 요청을 완료하지 못했습니다.');
    error.code = payload.code || null;
    error.status = response.status;
    throw error;
  }
  return payload;
}

export async function loadCardConnections(organizationId) {
  const payload = await cardConnectionRequest('card-connections', { query: { organizationId } });
  return payload.connections || [];
}

export async function createCardConnection({ organizationId, provider = 'mock', businessType = 'corporation' }) {
  const payload = await cardConnectionRequest('card-connections', {
    method: 'POST',
    body: { organizationId, provider, businessType, consentVersion: '2026-09-10' },
  });
  return payload.connection;
}

export async function discoverCardConnectionAssets({ organizationId, connectionId }) {
  const payload = await cardConnectionRequest('card-connection-assets', {
    method: 'POST', body: { organizationId, connectionId, action: 'discover' },
  });
  return payload.assets || [];
}

export async function selectCardConnectionAssets({ organizationId, connectionId, assetIds }) {
  const payload = await cardConnectionRequest('card-connection-assets', {
    method: 'POST', body: { organizationId, connectionId, action: 'select', assetIds },
  });
  return payload.cards || [];
}

export async function syncCardConnection({ organizationId, connectionId, mode = 'backfill' }) {
  const payload = await cardConnectionRequest('card-sync', {
    method: 'POST', body: { organizationId, connectionId, mode },
  });
  return payload;
}
export async function reauthenticateCardConnection({ organizationId, connectionId, authentication }) {
  const payload = await cardConnectionRequest('card-connection-reauth', {
    method: 'POST', body: { organizationId, connectionId, authentication },
  });
  return payload.connection;
}
export async function loadCardConnectionHistory({ organizationId, connectionId }) {
  const payload = await cardConnectionRequest('card-connection-history', { query: { organizationId, connectionId } });
  return payload.history || [];
}
export async function loadCardTransactions(organizationId, from, to) {
  let query = requireClient().from('timefit_user_card_transaction_groups').select('*, card:timefit_user_corporate_cards(issuer,nickname,last4)').eq('organization_id', organizationId).order('approved_at', { ascending: false }).limit(500);
  if (from) query = query.gte('approved_at', `${from}T00:00:00+09:00`);
  if (to) query = query.lte('approved_at', `${to}T23:59:59+09:00`);
  const { data, error } = await query; if (error) throw error;
  return (data || []).map(item => ({
    ...item,
    amount: Number(item.net_amount || 0),
    transaction_type: item.status === 'cancelled' ? 'cancellation' : item.status === 'partially_cancelled' ? 'partial_cancellation' : item.status,
  }));
}
export async function importCardTransactions({ organizationId, corporateCardId, rows }) {
  if (!rows.length) return { imported: 0, duplicates: 0 };
  const events = rows.map(row => {
    const eventType = row.transactionType === 'cancellation' ? 'cancellation' : row.transactionType === 'partial_cancellation' ? 'partial_cancellation' : row.transactionType === 'acquisition' ? 'acquisition' : 'approval';
    const identity = row.sourceTransactionId || `${row.approvedAt}-${row.amount}-${eventType}-${row.merchantName}`;
    const groupIdentity = row.groupKey || (row.approvalNumber ? `csv:approval:${row.approvalNumber}` : `csv:fingerprint:${row.approvedAt}-${row.amount}-${row.merchantName}`);
    return { providerEventId: identity, groupKey: groupIdentity, eventType, occurredAt: row.approvedAt, amount: Number(row.amount), currency: 'KRW', approvalNumber: row.approvalNumber || null, originalProviderEventId: row.originalProviderEventId || null, merchantName: row.merchantName, rawChecksum: identity };
  });
  const { data, error } = await requireClient().rpc('timefit_user_import_card_events', { p_organization_id: organizationId, p_corporate_card_id: corporateCardId, p_provider: 'csv', p_events: events });
  if (error) throw error; return data || { imported: 0, duplicates: 0 };
}
export async function loadMeetingNotes(organizationId) {
  const { data, error } = await requireClient().from('timefit_user_meeting_notes').select('*').eq('organization_id', organizationId).order('meeting_at', { ascending: false });
  if (error) throw error; return data || [];
}
export async function createMeetingNote(note) {
  const client = requireClient(); const userId = (await client.auth.getUser()).data.user?.id;
  const { data, error } = await client.from('timefit_user_meeting_notes').insert({ ...note, created_by: userId }).select().single();
  if (error) throw error; return data;
}
export async function tabletAttendance(payload) {
  const { data, error } = await requireClient().rpc('timefit_user_tablet_attendance_v2', { p_device_token: payload.deviceToken, p_phone_last4: String(payload.phoneLast4), p_action: payload.action });
  if (error) throw error; return data;
}
export async function getTabletDeviceContext(deviceToken) {
  const { data, error } = await requireClient().rpc('timefit_user_tablet_device_context', { p_device_token: deviceToken });
  if (error) throw error; return data;
}
export async function activateTabletDevice({ organizationId, displayName }) {
  const { data, error } = await requireClient().rpc('timefit_user_activate_tablet_device', { p_organization_id: organizationId, p_display_name: displayName, p_metadata: { userAgent: navigator.userAgent } });
  if (error) throw error; return data;
}
export async function getManagerTabletOrganization() {
  const client = requireClient();
  // Resolve the manager-owned business server-side. This also handles users
  // that have employee memberships in other businesses.
  const { data, error } = await client.rpc('timefit_user_get_manager_tablet_organization');
  if (error) throw error;
  if (!data?.organizationId) throw new Error('tablet_manager_required');
  return { organization_id: data.organizationId };
}
export async function loadTabletDevices(organizationId) {
  const { data, error } = await requireClient().from('timefit_user_tablet_devices').select('id,display_name,status,activated_at,last_used_at,expires_at').eq('organization_id', organizationId).order('activated_at', { ascending: false });
  if (error) throw error; return data || [];
}
export async function revokeTabletDevice(deviceId) {
  const client = requireClient(); const userId = (await client.auth.getUser()).data.user?.id;
  const { data, error } = await client.from('timefit_user_tablet_devices').update({ status: 'revoked', revoked_at: new Date().toISOString(), revoked_by: userId }).eq('id', deviceId).eq('status', 'active').select().single();
  if (error) throw error; return data;
}
export async function tabletLeaveRequest(payload) {
  const { data, error } = await requireClient().rpc('timefit_user_tablet_leave_request_v2', { p_device_token: payload.deviceToken, p_phone_last8: String(payload.phoneLast8), p_starts_on: payload.startsOn, p_ends_on: payload.endsOn, p_leave_type: payload.leaveType });
  if (error) throw error; return data;
}
export async function previewTabletLeaveRequest(payload) {
  const { data, error } = await requireClient().rpc('timefit_user_tablet_leave_preview_v3', { p_device_token: payload.deviceToken, p_phone_last8: String(payload.phoneLast8), p_starts_on: payload.startsOn, p_ends_on: payload.endsOn, p_leave_type: payload.leaveType });
  if (error) throw error; return data;
}
export async function updateStaffPhone(staffId, phone) {
  const { data, error } = await requireClient().rpc('timefit_user_set_staff_phone', { p_staff_id: staffId, p_phone: phone });
  if (error) throw error; return data;
}
export async function updateStaffProfile({ staffId, name, phone, department, categoryId, jobTitle, payType, hourlyWage, dailyWage, monthlySalary, annualSalary, joinedOn }) {
  const { data, error } = await requireClient().rpc('timefit_user_update_staff_profile', { p_staff_id: staffId, p_name: name, p_phone: phone, p_department: department || null, p_job_title: jobTitle, p_pay_type: payType, p_hourly_wage: hourlyWage || null, p_daily_wage: dailyWage || null, p_monthly_salary: monthlySalary || null, p_annual_salary: annualSalary || null, p_joined_on: joinedOn, p_category_id: categoryId || null });
  if (error) throw error; return data;
}
export async function grantStaffLeave({ staffId, amount, reason }) {
  const { data, error } = await requireClient().rpc('timefit_user_grant_leave', { p_staff_id: staffId, p_amount: amount, p_reason: reason || null });
  if (error) throw error; return data;
}
export async function runMonthEndOperations({ organizationId, targetMonth }) {
  const { data, error } = await requireClient().rpc('timefit_user_run_month_end_operations', {
    p_organization_id: organizationId,
    p_target_month: `${targetMonth}-01`,
  });
  if (error) throw error;
  return data;
}
export async function createManualStaff({ organizationId, name, phone, department, categoryId, jobTitle, payType, hourlyWage, dailyWage, monthlySalary, annualSalary, joinedOn }) {
  const { data, error } = await requireClient().rpc('timefit_user_create_manual_staff', {
    p_organization_id: organizationId, p_name: name, p_phone: phone, p_department: department || null, p_job_title: jobTitle || null,
    p_pay_type: payType, p_hourly_wage: hourlyWage || null, p_daily_wage: dailyWage || null, p_monthly_salary: monthlySalary || null, p_annual_salary: annualSalary || null, p_joined_on: joinedOn || null, p_category_id: categoryId || null,
  });
  if (error) throw error; return data;
}

export async function uploadStaffAvatar({ organizationId, staffId, file, previousPath }) {
  const client = requireClient();
  if (!file?.size) throw new Error('업로드할 사진을 선택해 주세요.');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('JPG, PNG 또는 WebP 사진만 등록할 수 있어요.');
  if (file.size > 5 * 1024 * 1024) throw new Error('프로필 사진은 5MB 이하만 등록할 수 있어요.');
  const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${organizationId}/${staffId}/avatar-${Date.now()}.${extension}`;
  const { error: uploadError } = await client.storage.from('timefit-staff-avatars').upload(path, file, { contentType: file.type, upsert: false });
  if (uploadError) throw uploadError;
  const { error: updateError } = await client.from('timefit_user_staff').update({ avatar_path: path }).eq('id', staffId).eq('organization_id', organizationId);
  if (updateError) { await client.storage.from('timefit-staff-avatars').remove([path]); throw updateError; }
  if (previousPath) await client.storage.from('timefit-staff-avatars').remove([previousPath]);
  return path;
}

async function sensitiveProfileRequest(method, staffId, body) {
  const client = requireClient(); const { data: { session } } = await client.auth.getSession();
  if (!session?.access_token) throw new Error('로그인이 필요합니다.');
  const response = await fetch(method === 'GET' ? `/api/staff-sensitive-profile?staffId=${encodeURIComponent(staffId)}` : '/api/staff-sensitive-profile', { method, headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify({ staffId, ...body }) : undefined });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || '민감 정보를 저장하지 못했습니다.');
  return payload.profile || null;
}
export const loadStaffSensitiveProfile = staffId => sensitiveProfileRequest('GET', staffId);
export const saveStaffSensitiveProfile = ({ staffId, bankName, bankAccount, residentRegistrationNumber }) => sensitiveProfileRequest('POST', staffId, { bankName, bankAccount, residentRegistrationNumber });
