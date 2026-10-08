import { createClient } from 'npm:@supabase/supabase-js@2.49.4'

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Content-Type': 'application/json' }
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
    const accountId = String(body.accountId || '')
    const action = String(body.action || '')
    const { data: organization } = await admin.from('timefit_user_organizations').select('owner_id').eq('id', organizationId).maybeSingle()
    if (!organization || organization.owner_id !== caller.user.id) throw new Error('organization_owner_required')
    const { data: account } = await admin.from('timefit_user_management_accounts').select('id,user_id,account_origin,role_code,status,staff_id').eq('id', accountId).eq('organization_id', organizationId).maybeSingle()
    if (!account) throw new Error('management_account_not_found')
    if (action === 'delete') {
      if (account.account_origin === 'linked_employee') {
        await admin.from('timefit_user_management_audit_logs').insert({ organization_id: organizationId, management_account_id: account.id, target_user_id: account.user_id, actor_user_id: caller.user.id, action: 'revoked', before_state: account })
        const { error } = await admin.from('timefit_user_management_accounts').delete().eq('id', account.id)
        if (error) throw error
        return new Response(JSON.stringify({ deleted: true, employeeAccountPreserved: true }), { headers })
      }
      const { error } = await admin.auth.admin.deleteUser(account.user_id)
      if (error) throw error
      return new Response(JSON.stringify({ deleted: true, employeeAccountPreserved: false }), { headers })
    }
    if (action !== 'update') throw new Error('invalid_management_account_action')
    const roleCode = String(body.roleCode || '')
    const status = String(body.status || '')
    const requestedPermissions = [...new Set((Array.isArray(body.permissions) ? body.permissions : []).map(String))]
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
    const categoryIds = [...new Set((Array.isArray(body.categoryIds) ? body.categoryIds : []).map(String))]
    const costCenterIds = [...new Set((Array.isArray(body.costCenterIds) ? body.costCenterIds : []).map(String))]
    if (!['manager','executive_chef'].includes(roleCode) || !['active','suspended'].includes(status) || permissions.some(code => !permissionCodes.has(code))) throw new Error('invalid_management_account_input')
    const { error: updateError } = await admin.from('timefit_user_management_accounts').update({ role_code: roleCode, status, staff_id: body.staffId || null, updated_at: new Date().toISOString() }).eq('id', accountId)
    if (updateError) throw updateError
    const { error: permissionDeleteError } = await admin.from('timefit_user_management_permissions').delete().eq('management_account_id', accountId)
    if (permissionDeleteError) throw permissionDeleteError
    if (permissions.length) {
      const { error } = await admin.from('timefit_user_management_permissions').insert(permissions.map(permissionCode => ({ management_account_id: accountId, permission_code: permissionCode, allowed: true })))
      if (error) throw error
    }
    const { error: scopeDeleteError } = await admin.from('timefit_user_management_scopes').delete().eq('management_account_id', accountId)
    if (scopeDeleteError) throw scopeDeleteError
    if (categoryIds.length) {
      const { error } = await admin.from('timefit_user_management_scopes').insert(categoryIds.map(categoryId => ({ management_account_id: accountId, category_id: categoryId })))
      if (error) throw error
    }
    const { error: costCenterScopeDeleteError } = await admin.from('timefit_user_management_cost_center_scopes').delete().eq('management_account_id', accountId)
    if (costCenterScopeDeleteError) throw costCenterScopeDeleteError
    if (costCenterIds.length) {
      const { error } = await admin.from('timefit_user_management_cost_center_scopes').insert(costCenterIds.map(costCenterId => ({ management_account_id: accountId, cost_center_id: costCenterId })))
      if (error) throw error
    }
    await admin.from('timefit_user_management_audit_logs').insert({ organization_id: organizationId, management_account_id: account.id, target_user_id: account.user_id, actor_user_id: caller.user.id, action: status === 'suspended' ? 'suspended' : account.status === 'suspended' ? 'reactivated' : 'updated', before_state: account, after_state: { roleCode, status, staffId: body.staffId || null, permissions, categoryIds, costCenterIds } })
    return new Response(JSON.stringify({ updated: true }), { headers })
  } catch (error) {
    const message = error instanceof Error ? error.message : JSON.stringify(error)
    return new Response(JSON.stringify({ error: message }), { status: /unauthorized/.test(message) ? 401 : /owner_required/.test(message) ? 403 : 400, headers })
  }
})
