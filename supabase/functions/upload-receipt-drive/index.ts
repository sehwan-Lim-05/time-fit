import { createClient } from 'npm:@supabase/supabase-js@2.49.4'

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers })
const base64Url = (value: Uint8Array | string) => {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  let binary = ''
  bytes.forEach(byte => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

const decodeCredentials = () => {
  const encoded = Deno.env.get('GOOGLE_DRIVE_CREDENTIALS_B64') || Deno.env.get('GOOGLE_VISION_CREDENTIALS_B64') || ''
  if (!encoded) throw new Error('google_drive_credentials_missing')
  try { return JSON.parse(atob(encoded)) as { client_email: string; private_key: string } }
  catch { throw new Error('google_drive_credentials_invalid') }
}

const pemBytes = (pem: string) => {
  const binary = atob(pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, ''))
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

async function serviceAccountAccessToken() {
  const credentials = decodeCredentials()
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/drive.file',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }))}`
  const key = await crypto.subtle.importKey('pkcs8', pemBytes(credentials.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  const assertion = `${unsigned}.${base64Url(new Uint8Array(signature))}`
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  })
  const payload = await response.json()
  if (!response.ok || !payload.access_token) throw new Error(`google_drive_token_failed:${payload.error_description || payload.error || response.status}`)
  return String(payload.access_token)
}

async function googleAccessToken() {
  const refreshToken = Deno.env.get('GOOGLE_DRIVE_REFRESH_TOKEN') || ''
  const clientId = Deno.env.get('GOOGLE_DRIVE_CLIENT_ID') || ''
  const clientSecret = Deno.env.get('GOOGLE_DRIVE_CLIENT_SECRET') || ''
  if (!refreshToken) return serviceAccountAccessToken()
  if (!clientId || !clientSecret) throw new Error('google_drive_oauth_credentials_missing')
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  })
  const payload = await response.json()
  if (!response.ok || !payload.access_token) throw new Error(`google_drive_refresh_failed:${payload.error_description || payload.error || response.status}`)
  return String(payload.access_token)
}

const safeFileName = (name: string) => name.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 160) || 'receipt'

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers })
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  try {
    const token = request.headers.get('Authorization')?.replace('Bearer ', '') || ''
    const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: authData } = await admin.auth.getUser(token)
    if (!authData.user) return json({ error: 'unauthorized' }, 401)

    const form = await request.formData()
    const organizationId = String(form.get('organizationId') || '')
    const file = form.get('file')
    if (!organizationId || !(file instanceof File) || !file.size) return json({ error: 'invalid_receipt_upload' }, 400)
    if (file.size > 20 * 1024 * 1024) return json({ error: 'receipt_file_too_large' }, 413)
    if (!(file.type.startsWith('image/') || file.type === 'application/pdf')) return json({ error: 'unsupported_receipt_file' }, 400)

    const { data: membership } = await admin.from('timefit_user_memberships').select('organization_id').eq('organization_id', organizationId).eq('user_id', authData.user.id).maybeSingle()
    if (!membership) return json({ error: 'organization_access_denied' }, 403)

    const folderId = Deno.env.get('GOOGLE_DRIVE_FOLDER_ID') || ''
    if (!folderId) throw new Error('google_drive_folder_missing')
    const accessToken = await googleAccessToken()
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date())
    const metadata = {
      name: `${organizationId}_${date}_${crypto.randomUUID().slice(0, 8)}_${safeFileName(file.name)}`,
      parents: [folderId],
      description: `Timefit receipt upload · organization ${organizationId} · user ${authData.user.id}`,
    }
    const boundary = `timefit_${crypto.randomUUID()}`
    const prefix = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${file.type}\r\n\r\n`)
    const suffix = new TextEncoder().encode(`\r\n--${boundary}--`)
    const body = new Blob([prefix, await file.arrayBuffer(), suffix])
    const upload = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,size,createdTime,webViewLink,webContentLink', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    })
    const result = await upload.json()
    if (!upload.ok || !result.id) throw new Error(`google_drive_upload_failed:${result.error?.message || upload.status}`)
    return json({ file: result })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return json({ error: message }, /missing|invalid_receipt|unsupported|too_large/.test(message) ? 400 : 500)
  }
})
