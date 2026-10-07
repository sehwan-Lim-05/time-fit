import { createClient } from 'npm:@supabase/supabase-js@2'

const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Content-Type': 'application/json' }

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  try {
    const token = request.headers.get('Authorization')?.replace('Bearer ', '')
    if (!token) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers })
    const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } })
    const { data: userData, error: userError } = await admin.auth.getUser(token)
    if (userError || !userData.user) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers })
    const userId = userData.user.id
    const { data: profile, error: profileError } = await admin.from('timefit_user_accounts').select('id, display_name, employee_code, role').eq('id', userId).maybeSingle()
    if (profileError) throw profileError
    const { data: membership, error: membershipError } = await admin.from('timefit_user_memberships').select('organization_id, role').eq('user_id', userId).limit(1).maybeSingle()
    if (membershipError) throw membershipError
    const organization = membership ? (await admin.from('timefit_user_organizations').select('id, name, owner_id').eq('id', membership.organization_id).maybeSingle()).data : null
    const managementAccount = membership ? (await admin.from('timefit_user_management_accounts').select('id,staff_id,login_id,role_code,status,force_password_change').eq('organization_id', membership.organization_id).eq('user_id', userId).eq('status', 'active').maybeSingle()).data : null
    const permissions = managementAccount ? (await admin.from('timefit_user_management_permissions').select('permission_code').eq('management_account_id', managementAccount.id).eq('allowed', true)).data?.map(row => row.permission_code) || [] : []
    const categoryScopes = managementAccount ? (await admin.from('timefit_user_management_scopes').select('category_id').eq('management_account_id', managementAccount.id)).data?.map(row => row.category_id) || [] : []
    const { data: invitation, error: invitationError } = await admin.from('timefit_user_invitations').select('id, organization_id, status').eq('target_user_id', userId).eq('status', 'pending').limit(1).maybeSingle()
    if (invitationError) throw invitationError
    const invitationOrganization = invitation ? (await admin.from('timefit_user_organizations').select('name').eq('id', invitation.organization_id).maybeSingle()).data : null
    return new Response(JSON.stringify({ profile, membership: membership ? { ...membership, timefit_user_organizations: organization } : null, managementAccount: managementAccount ? { ...managementAccount, permissions, categoryScopes } : null, isOrganizationOwner: organization?.owner_id === userId || (membership?.role === 'manager' && !managementAccount), invitation: invitation ? { ...invitation, timefit_user_organizations: invitationOrganization } : null }), { headers })
  } catch (error) { return new Response(JSON.stringify({ error: error instanceof Error ? error.message : (error as { message?: string }).message || JSON.stringify(error) }), { status: 400, headers }) }
})
