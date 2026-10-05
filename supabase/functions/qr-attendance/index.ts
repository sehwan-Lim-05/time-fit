import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

type QrAttendanceRequest = { token: string; requestKey: string };

Deno.serve(async (request) => {
  if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const body = await request.json() as QrAttendanceRequest;
  if (!body.token || !body.requestKey) return Response.json({ error: 'invalid_payload' }, { status: 400 });

  const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } });
  const { data, error } = await client.rpc('timefit_user_mobile_qr_attendance', { p_token: body.token, p_request_key: body.requestKey });
  if (error) return Response.json({ error: error.message }, { status: 422 });
  return Response.json({ data });
});
