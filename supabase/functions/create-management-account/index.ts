import { createClient } from 'npm:@supabase/supabase-js@2.49.4'

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Content-Type': 'application/json' }
const loginEmail = (loginId: string) => `${loginId.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '')}@accounts.timefit.local`

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } })
  try {
    const token = request.headers.get('Authorization')?.replace('Bearer ', '')
    const { data: caller } = await admin.auth.getUser(token || '')
    if (!caller.user) throw new Error('unauthorized')
    const body = await request.json()
    const organizationId = String(body.organizationId || '')
    const loginId = String(body.loginId || '').trim().toLowerCase()
    const password = String(body.temporaryPassword || '')
    const displayName = String(body.displayName || '').trim()
    const roleCode = String(body.roleCode || '')
    const requestedPermissions = Array.isArray(body.permissions) ? body.permissions.map(String) : []
    const permissions = [...new Set([
      ...requestedPermissions,
      ...(requestedPermissions.includes('employee.manage') ? ['employee.view'] : []),
    ])]
    const categoryIds = Array.isArray(body.categoryIds) ? body.categoryIds : []
    const costCenterIds = Array.isArray(body.costCenterIds) ? body.costCenterIds : []
    if (!organizationId || !/^[a-z0-9._-]{4,30}$/.test(loginId) || password.length < 8 || !displayName || !['manager','executive_chef'].includes(roleCode)) throw new Error('invalid_management_account_input')
    const { data: organization } = await admin.from('timefit_user_organizations').select('owner_id').eq('id', organizationId).maybeSingle()
    const { data: managerMembership } = await admin.from('timefit_user_memberships').select('role').eq('organization_id', organizationId).eq('user_id', caller.user.id).maybeSingle()
    const { data: delegatedAccount } = await admin.from('timefit_user_management_accounts').select('id').eq('organization_id', organizationId).eq('user_id', caller.user.id).maybeSingle()
    if (organization?.owner_id !== caller.user.id && (managerMembership?.role !== 'manager' || delegatedAccount)) throw new Error('organization_owner_required')
    const email = loginEmail(loginId)
    const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { role: 'employee', display_name: displayName, management_login_id: loginId } })
    if (createError) throw createError
    const userId = created.user.id
    try {
      await admin.from('timefit_user_accounts').upsert({ id: userId, role: 'employee', display_name: displayName })
      await admin.from('timefit_user_memberships').upsert({ organization_id: organizationId, user_id: userId, role: 'employee' })
      const { data: account, error: accountError } = await admin.from('timefit_user_management_accounts').insert({ organization_id: organizationId, user_id: userId, staff_id: body.staffId || null, login_id: loginId, role_code: roleCode, created_by: caller.user.id }).select().single()
      if (accountError) throw accountError
      if (permissions.length) await admin.from('timefit_user_management_permissions').insert(permissions.map((permissionCode: string) => ({ management_account_id: account.id, permission_code: permissionCode, allowed: true })))
      if (categoryIds.length) await admin.from('timefit_user_management_scopes').insert(categoryIds.map((categoryId: string) => ({ management_account_id: account.id, category_id: categoryId })))
      if (costCenterIds.length) await admin.from('timefit_user_management_cost_center_scopes').insert(costCenterIds.map((costCenterId: string) => ({ management_account_id: account.id, cost_center_id: costCenterId })))
      return new Response(JSON.stringify({ account: { ...account, display_name: displayName }, loginId, loginEmail: email }), { headers })
    } catch (error) {
      await admin.auth.admin.deleteUser(userId)
      throw error
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : JSON.stringify(error)
    return new Response(JSON.stringify({ error: message }), { status: /unauthorized/.test(message) ? 401 : /owner_required/.test(message) ? 403 : 400, headers })
  }
})
