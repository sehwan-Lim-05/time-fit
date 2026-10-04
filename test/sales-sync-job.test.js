import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceSalesJob } from '../server/api/_sales-sync-job.js';
import handler from '../server/api/sync-sales.js';
const job = { id: 'job', run_token: 'token', window_from: null, window_to: '2026-09-17T00:00:00Z', next_page: 1, status: 'collecting' };
const providerOrder = id => ({ id, createdAt: '2026-09-01T00:00:00Z', chargePrice: { totalAmount: 100 } });
function fixture(overrides = {}) {
  const calls = [], urls = [];
  return { calls, urls, options: {
    organizationId: 'org', merchantId: 1, backfill: false, headers: {}, url: 'https://test/orders',
    normalize: order => ({ order_id: String(order.id), raw_order: order }), deadline: Date.now() + 10000,
    rpc: async (name, args) => { calls.push({ name, args }); return name.includes('claim') ? { ...job, ...overrides } : name.includes('finish') ? 501 : null; },
    read: async url => { urls.push(new URL(url)); return new Response(JSON.stringify({ resultType: 'SUCCESS', success: [] })); },
  } };
}
test('a full page is staged, released and resumed at its durable next page', async () => {
  const f = fixture(); f.options.maxPages = 1;
  f.options.read = async () => new Response(JSON.stringify({ resultType: 'SUCCESS', success: Array.from({ length: 500 }, (_, i) => providerOrder(i + 1)) }));
  assert.equal((await advanceSalesJob(f.options)).status, 'pending');
  assert.equal(f.calls.find(c => c.name.includes('stage')).args.p_complete, false);
  assert.equal(f.calls.some(c => c.name.includes('finish')), false);
  const resumed = fixture({ next_page: 2 });
  assert.equal((await advanceSalesJob(resumed.options)).status, 'completed');
  assert.equal(resumed.urls[0].searchParams.get('page'), '2');
  assert.equal(resumed.urls[0].searchParams.get('to'), job.window_to);
});
test('a claimed job is not fetched twice, and ready jobs finish without provider refetch', async () => {
  const f = fixture({ busy: true });
  assert.equal((await advanceSalesJob(f.options)).status, 'running'); assert.equal(f.urls.length, 0);
  const ready = fixture({ status: 'ready' });
  assert.equal((await advanceSalesJob(ready.options)).status, 'completed'); assert.equal(ready.urls.length, 0);
});
test('provider failure releases only its attempt token and does not publish partial rows', async () => {
  const f = fixture(); f.options.read = async () => new Response('{}', { status: 503 });
  await assert.rejects(advanceSalesJob(f.options), /503/);
  const release = f.calls.find(c => c.name.includes('release')).args;
  assert.equal(release.p_run_token, 'token'); assert.match(release.p_error, /503/);
  assert.equal(f.calls.some(c => c.name.includes('finish')), false);
});
test('too little time defers a job without marking it failed', async () => {
  const f = fixture(); f.options.deadline = Date.now();
  assert.equal((await advanceSalesJob(f.options)).status, 'pending');
  assert.equal(f.urls.length, 0); assert.equal(f.calls.at(-1).args.p_error, null);
});
test('a provider timeout is resumable pending, not a failed publication', async () => {
  const f = fixture();
  f.options.read = async () => { throw new DOMException('time budget reached', 'TimeoutError'); };
  assert.equal((await advanceSalesJob(f.options)).status, 'pending');
  assert.equal(f.calls.at(-1).args.p_error, null);
});
test('credentials come from the claimed snapshot and errors release the lease', async () => {
  const f = fixture({ credential_source: 'custom', encrypted_access_key: 'new-key' });
  let snapshot;
  f.options.headersForJob = claimed => { snapshot = claimed; return { 'x-access-key': claimed.encrypted_access_key }; };
  f.options.read = async (url, options) => {
    assert.equal(options.headers['x-access-key'], 'new-key');
    return new Response(JSON.stringify({ resultType: 'SUCCESS', success: [] }));
  };
  await advanceSalesJob(f.options); assert.equal(snapshot.credential_source, 'custom');
  const missing = fixture(); missing.options.headersForJob = () => { throw Error('credentials missing'); };
  await assert.rejects(advanceSalesJob(missing.options), /credentials missing/);
  assert.equal(missing.calls.at(-1).name, 'timefit_user_release_sales_job');
});
test('failure of one cron store does not prevent the next store publishing', async t => {
  process.env.SUPABASE_URL = 'https://test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'test'; process.env.CRON_SECRET = 'test';
  process.env.TOSSPLACE_ACCESS_KEY = 'test'; process.env.TOSSPLACE_ACCESS_SECRET = 'test';
  const queried = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.includes('connections?')) return new Response(JSON.stringify([{ organization_id: 'first', merchant_id: 1 }, { organization_id: 'second', merchant_id: 2 }]));
    if (url.includes('sales_sync_runs') && options.method === 'POST') return new Response(JSON.stringify([{ id: `run-${JSON.parse(options.body)[0].organization_id}` }]));
    if (url.includes('open-api.tossplace.com')) {
      queried.push(url);
      return url.includes('/merchants/1/') ? new Response('{}', { status: 503 }) : new Response(JSON.stringify({ resultType: 'SUCCESS', success: [] }));
    }
    return new Response('null');
  });
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method: 'GET', headers: { authorization: 'Bearer test' }, query: {} }, res);
  assert.equal(queried.length, 2); assert.equal(res.body.failed, 1);
  assert.equal(res.body.results[1].status, 'completed');
});
