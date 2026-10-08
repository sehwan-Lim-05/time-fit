import { createClient } from 'npm:@supabase/supabase-js@2.49.4'

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Content-Type': 'application/json' }
const loginEmail = (loginId: string) => `${loginId.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '')}@accounts.timefit.local`
const permissionCodes = new Set([
  'dashboard.view','attendance.view','attendance.manage','attendance.review_correction','schedule.view','schedule.manage','schedule.approve','leave.view','leave.review','payroll.view','employee.view','employee.manage','employee.compensation.view','employee.compensation.manage',
  'sales.view','sales.sync','settings.manage','finance.view','expense.manage','expense.receipt.review','expense.card.manage','expense.closeout.manage','expense.export',
])

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } })
  try {
    const token = request.headers.get('Authorization')?.replace('Bearer ', '')
    const { data: caller } = await admin.auth.getUser(token || '')
    if (!caller.user) throw new Error('unauthorized')
    const body = await request.json()
    const organizationId = String(body.organizationId || '')
    const accountMode = body.accountMode === 'link_existing' ? 'link_existing' : 'standalone'
    const loginId = String(body.loginId || '').trim().toLowerCase()
    const password = String(body.temporaryPassword || '')
    const displayName = String(body.displayName || '').trim()
    const roleCode = String(body.roleCode || '')
    const requestedPermissions = Array.isArray(body.permissions) ? body.permissions.map(String) : []
    const dependencies: Record<string, string[]> = {
      'attendance.manage': ['attendance.view'], 'attendance.review_correction': ['attendance.view'],
      'schedule.manage': ['schedule.view'], 'schedule.approve': ['schedule.view'],
      'leave.review': ['leave.view'], 'employee.manage': ['employee.view'],
      'employee.compensation.view': ['employee.view'],
      'employee.compensation.manage': ['employee.view', 'employee.compensation.view'],
      'sales.sync': ['sales.view'], 'expense.manage': ['finance.view'],
      'expense.receipt.review': ['finance.view'], 'expense.card.manage': ['finance.view'],
      'expense.closeout.manage': ['finance.view'], 'expense.export': ['finance.view'],
    }
    const permissions = [...new Set([...requestedPermissions, ...requestedPermissions.flatMap(code => dependencies[code] || [])])]
    const categoryIds = Array.isArray(body.categoryIds) ? body.categoryIds : []
    const costCenterIds = Array.isArray(body.costCenterIds) ? body.costCenterIds : []
    if (!organizationId || !['manager','executive_chef'].includes(roleCode) || permissions.some(code => !permissionCodes.has(code))) throw new Error('invalid_management_account_input')
    if (accountMode === 'standalone' && (!/^[a-z0-9._-]{4,30}$/.test(loginId) || password.length < 8 || !displayName)) throw new Error('invalid_management_account_input')
    const { data: organization } = await admin.from('timefit_user_organizations').select('owner_id').eq('id', organizationId).maybeSingle()
    const { data: managerMembership } = await admin.from('timefit_user_memberships').select('role').eq('organization_id', organizationId).eq('user_id', caller.user.id).maybeSingle()
    const { data: delegatedAccount } = await admin.from('timefit_user_management_accounts').select('id').eq('organization_id', organizationId).eq('user_id', caller.user.id).maybeSingle()
    if (organization?.owner_id !== caller.user.id && (managerMembership?.role !== 'manager' || delegatedAccount)) throw new Error('organization_owner_required')
    if (accountMode === 'link_existing') {
      const staffId = String(body.staffId || '')
      const { data: staff, error: staffError } = await admin.from('timefit_user_staff').select('id,user_id,display_name').eq('id', staffId).eq('organization_id', organizationId).maybeSingle()
      if (staffError) throw staffError
      if (!staff?.user_id) throw new Error('linked_employee_account_required')
      const { data: existingManagement } = await admin.from('timefit_user_management_accounts').select('id').eq('organization_id', organizationId).eq('user_id', staff.user_id).maybeSingle()
      if (existingManagement) throw new Error('management_account_already_linked')
      const { data: linkedAuth, error: linkedAuthError } = await admin.auth.admin.getUserById(staff.user_id)
      if (linkedAuthError || !linkedAuth.user) throw linkedAuthError || new Error('linked_employee_account_required')
      const linkedLoginId = String(linkedAuth.user.user_metadata?.management_login_id || linkedAuth.user.email?.split('@')[0] || staff.user_id).toLowerCase()
      const { data: account, error: accountError } = await admin.from('timefit_user_management_accounts').insert({ organization_id: organizationId, user_id: staff.user_id, staff_id: staff.id, login_id: linkedLoginId, role_code: roleCode, account_origin: 'linked_employee', force_password_change: false, created_by: caller.user.id }).select().single()
      if (accountError) throw accountError
      if (permissions.length) await admin.from('timefit_user_management_permissions').insert(permissions.map((permissionCode: string) => ({ management_account_id: account.id, permission_code: permissionCode, allowed: true })))
      if (categoryIds.length) await admin.from('timefit_user_management_scopes').insert(categoryIds.map((categoryId: string) => ({ management_account_id: account.id, category_id: categoryId })))
      if (costCenterIds.length) await admin.from('timefit_user_management_cost_center_scopes').insert(costCenterIds.map((costCenterId: string) => ({ management_account_id: account.id, cost_center_id: costCenterId })))
      await admin.from('timefit_user_management_audit_logs').insert({ organization_id: organizationId, management_account_id: account.id, target_user_id: staff.user_id, actor_user_id: caller.user.id, action: 'linked', after_state: { roleCode, permissions, categoryIds, costCenterIds } })
      return new Response(JSON.stringify({ account, linkedExistingEmployee: true, loginId: linkedLoginId }), { headers })
    }

    const email = loginEmail(loginId)
    const { data: created, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { role: 'employee', display_name: displayName, management_login_id: loginId } })
    if (createError) throw createError
    const userId = created.user.id
    try {
      await admin.from('timefit_user_accounts').upsert({ id: userId, role: 'employee', display_name: displayName })
      await admin.from('timefit_user_memberships').upsert({ organization_id: organizationId, user_id: userId, role: 'employee' })
      const { data: account, error: accountError } = await admin.from('timefit_user_management_accounts').insert({ organization_id: organizationId, user_id: userId, staff_id: body.staffId || null, login_id: loginId, role_code: roleCode, account_origin: 'standalone', created_by: caller.user.id }).select().single()
      if (accountError) throw accountError
      if (permissions.length) await admin.from('timefit_user_management_permissions').insert(permissions.map((permissionCode: string) => ({ management_account_id: account.id, permission_code: permissionCode, allowed: true })))
      if (categoryIds.length) await admin.from('timefit_user_management_scopes').insert(categoryIds.map((categoryId: string) => ({ management_account_id: account.id, category_id: categoryId })))
      if (costCenterIds.length) await admin.from('timefit_user_management_cost_center_scopes').insert(costCenterIds.map((costCenterId: string) => ({ management_account_id: account.id, cost_center_id: costCenterId })))
      await admin.from('timefit_user_management_audit_logs').insert({ organization_id: organizationId, management_account_id: account.id, target_user_id: userId, actor_user_id: caller.user.id, action: 'created', after_state: { roleCode, permissions, categoryIds, costCenterIds } })
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
