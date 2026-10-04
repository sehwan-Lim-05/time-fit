export function financeServerConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function serviceHeaders(extra = {}) {
  return {
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

export async function authenticatedUser(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;
  return { user: await response.json(), token };
}

export async function authorizeFinance(req, organizationId, { ownerOnly = false, permissionsAny = [] } = {}) {
  if (!organizationId) return null;
  const auth = await authenticatedUser(req);
  if (!auth?.user?.id) return null;
  const select = ownerOnly ? 'id,owner_id' : 'id,owner_id';
  const orgResponse = await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_organizations?id=eq.${encodeURIComponent(organizationId)}&select=${select}`, { headers: serviceHeaders() });
  const organizations = orgResponse.ok ? await orgResponse.json() : [];
  const organization = organizations[0];
  if (!organization) return null;
  if (organization.owner_id === auth.user.id) return { ...auth, isOwner: true };
  if (ownerOnly) return null;
  const membershipResponse = await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_memberships?organization_id=eq.${encodeURIComponent(organizationId)}&user_id=eq.${encodeURIComponent(auth.user.id)}&select=organization_id`, { headers: serviceHeaders() });
  const memberships = membershipResponse.ok ? await membershipResponse.json() : [];
  if (!memberships.length) return null;
  const accountResponse = await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_management_accounts?organization_id=eq.${encodeURIComponent(organizationId)}&user_id=eq.${encodeURIComponent(auth.user.id)}&status=eq.active&select=id&limit=1`, { headers: serviceHeaders() });
  const accounts = accountResponse.ok ? await accountResponse.json() : [];
  if (!accounts[0]?.id) return null;
  if (!permissionsAny.length) return { ...auth, isOwner: false, managementAccountId: accounts[0].id };
  const requested = permissionsAny.map(code => `permission_code.eq.${encodeURIComponent(code)}`).join(',');
  const permissionResponse = await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_management_permissions?management_account_id=eq.${encodeURIComponent(accounts[0].id)}&allowed=eq.true&or=(${requested})&select=permission_code`, { headers: serviceHeaders() });
  const permissions = permissionResponse.ok ? await permissionResponse.json() : [];
  return permissions.length ? { ...auth, isOwner: false, permissions: permissions.map(item => item.permission_code) } : null;
}

export async function authorizeOrganizationMember(req, organizationId) {
  if (!organizationId) return null;
  const auth = await authenticatedUser(req);
  if (!auth?.user?.id) return null;
  const membershipsResponse = await fetch(`${process.env.SUPABASE_URL}/rest/v1/timefit_user_memberships?organization_id=eq.${encodeURIComponent(organizationId)}&user_id=eq.${encodeURIComponent(auth.user.id)}&select=organization_id,role`, { headers: serviceHeaders() });
  const memberships = membershipsResponse.ok ? await membershipsResponse.json() : [];
  return memberships.length ? { ...auth, role: memberships[0].role } : null;
}

export async function canAccessFinanceCostCenter(auth, organizationId, costCenterId) {
  if (!costCenterId || auth?.isOwner) return true;
  if (!auth?.user?.id) return false;
  const accounts = await financeRest(`timefit_user_management_accounts?organization_id=eq.${encodeURIComponent(organizationId)}&user_id=eq.${encodeURIComponent(auth.user.id)}&status=eq.active&select=id&limit=1`);
  if (!accounts[0]?.id) return false;
  const scopes = await financeRest(`timefit_user_management_cost_center_scopes?management_account_id=eq.${encodeURIComponent(accounts[0].id)}&select=cost_center_id`);
  if (!scopes.length) return true;
  const centers = await financeRest(`timefit_user_cost_centers?organization_id=eq.${encodeURIComponent(organizationId)}&id=eq.${encodeURIComponent(costCenterId)}&select=id,parent_id&limit=1`);
  const target = centers[0];
  return Boolean(target && scopes.some(scope => scope.cost_center_id === target.id || scope.cost_center_id === target.parent_id));
}

export async function financeRest(path, options = {}) {
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: serviceHeaders(options.headers || {}),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`finance_rest_${response.status}`);
    error.status = response.status;
    error.detail = body?.message || body?.hint || null;
    throw error;
  }
  return body;
}

export function methodNotAllowed(res) {
  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}

export function financeError(res, error, fallback) {
  console.error(fallback, { message: error.message, status: error.status, detail: error.detail });
  return res.status(error.status === 409 ? 409 : 502).json({ ok: false, error: fallback });
}
