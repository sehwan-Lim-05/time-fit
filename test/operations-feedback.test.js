import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, attendanceIssues, changePercent, kstDate, lastCompleteWeek, payrollAttendanceRange, recentCompletedWeek, staffTodayStatus, validDate, validAttendanceCorrection, weeklySales } from '../shared/operations.js';
import handler, { readAll } from '../server/api/operations-feedback.js';

test('KST closed weeks cross month/year and never include the ongoing Sunday', () => {
  assert.equal(kstDate('2026-09-13T15:00:00Z'), '2026-09-14');
  assert.equal(lastCompleteWeek('2026-09-13').to, '2026-09-06');
  assert.deepEqual(lastCompleteWeek('2026-09-14'), { from: '2026-09-07', to: '2026-09-13', previousFrom: '2026-08-31', previousTo: '2026-09-06' });
  assert.equal(lastCompleteWeek('2026-01-01').from, '2025-12-22');
  assert.equal(validDate('2026-02-30'), false);
  assert.equal(changePercent(10, 0), null);
});

test('recent sales week ends yesterday and compares the preceding seven days', () => {
  assert.deepEqual(recentCompletedWeek('2026-09-23'), { from: '2026-09-16', to: '2026-09-22', previousFrom: '2026-09-09', previousTo: '2026-09-15' });
  assert.deepEqual(recentCompletedWeek('2026-01-01'), { from: '2025-12-25', to: '2025-12-31', previousFrom: '2025-12-18', previousTo: '2025-12-24' });
});
test('급여 확인 건수와 이동 목록은 동일한 월·어제까지의 기간을 사용한다', () => {
  assert.deepEqual(payrollAttendanceRange('2026-09', '2026-09-20'), { from: '2026-09-01', to: '2026-09-19' });
  assert.deepEqual(payrollAttendanceRange('2026-08', '2026-09-20'), { from: '2026-08-01', to: '2026-08-31' });
  const range = payrollAttendanceRange('2026-09', '2026-09-20');
  const staff = { id: 'staff', attendanceHistory: [], scheduleHistory: [] };
  const options = { ...range, now: new Date('2026-09-20T10:00:00+09:00') };
  assert.equal(attendanceIssues([staff], options).filter(issue => issue.types.includes('checkout')).length, 0);
  staff.attendanceHistory.push({ work_date: '2026-09-18', checked_in_at: '2026-09-18T09:00:00+09:00' });
  assert.equal(attendanceIssues([staff], options).filter(issue => issue.types.includes('checkout')).length, 1);
});
const employee = (records, schedules) => ({ id: 'staff', name: '테스트', attendanceHistory: records, scheduleHistory: schedules });
const shift = { work_date: '2026-09-16', starts_at: '22:00:00', ends_at: '06:00:00', approval_status: 'approved' };
const record = { work_date: shift.work_date, checked_in_at: '2026-09-16T22:00:00+09:00' };
test('오늘 직원 상태는 승인된 일정과 출퇴근 기록으로 판정한다', () => {
  const date = '2026-09-16', now = new Date('2026-09-16T10:00:00+09:00');
  assert.equal(staffTodayStatus(null, [], 'staff', date, now), '일정 없음');
  assert.equal(staffTodayStatus(null, [{ ...shift, approval_status: 'rejected' }], 'staff', date, now), '일정 없음');
  assert.equal(staffTodayStatus(null, [{ ...shift, staff_id: 'staff' }], 'staff', date, now), '예정');
  assert.equal(staffTodayStatus(null, [{ ...shift, staff_id: 'staff', starts_at: '09:00:00' }], 'staff', date, now), '미출근');
  assert.equal(staffTodayStatus({ checked_in_at: '2026-09-16T09:00:00+09:00' }, [], 'staff', date, now), '근무 중');
  assert.equal(staffTodayStatus({ checked_out_at: '2026-09-16T18:00:00+09:00' }, [], 'staff', date, now), '퇴근 완료');
});
const options = { from: '2026-09-01', to: '2026-09-16', now: new Date('2026-09-17T02:00:00+09:00') };
test('ongoing overnight shift is not a missing checkout or absence', () => {
  assert.equal(attendanceIssues([employee([record], [shift])], options).length, 0);
  assert.equal(attendanceIssues([employee([], [shift])], options).length, 0);
  assert.deepEqual(attendanceIssues([employee([record], [shift])], { ...options, now: new Date('2026-09-17T07:00:00+09:00') })[0].types, ['checkout']);
});
test('rejected schedules, approved full leave, current dates, overlapping issues', () => {
  const daytime = { ...shift, starts_at: '09:00:00', ends_at: '18:00:00' };
  assert.equal(attendanceIssues([employee([], [{ ...daytime, approval_status: 'rejected' }])], options).length, 0);
  assert.equal(attendanceIssues([employee([], [daytime])], { ...options, leaves: [{ staffId: 'staff', status: '승인 완료', type: '연차', amount: '1일', startsAt: shift.work_date }] }).length, 0);
  assert.equal(attendanceIssues([employee([], [daytime])], { ...options, leaves: [{ staffId: 'staff', status: '승인 완료', type: '오전반차', amount: '0.5일', startsAt: shift.work_date }] }).length, 1);
  const rows = attendanceIssues([employee([{ ...record, checked_in_at: '2026-09-16T00:00:00+09:00' }], [])], options);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].types, ['checkout', 'schedule']);
});
function salesFixture() {
  const range = recentCompletedWeek('2026-09-17');
  const orders = Array.from({ length: 14 }, (_, i) => ({ order_id: `order-${i}`, ordered_at: `${addDays(range.previousFrom, i)}T12:00:00+09:00`, state: 'COMPLETED', total_amount: i < 7 ? 100 : 200, raw_order: { lineItems: [{ item: { title: '메뉴', code: 'menu-1', category: { title: '식사' } }, itemPrice: { priceValue: 100 }, quantity: i < 7 ? 1 : 2 }, { item: { title: '무료 옵션' }, itemPrice: { priceValue: 0 }, quantity: 1 }] } }));
  const daily = orders.map(order => ({ sales_date: kstDate(order.ordered_at), order_count: 1 }));
  const syncRuns = [{ status: 'succeeded', page_complete: true, window_from: `${range.previousFrom}T00:00:00+09:00`, window_to: `${range.to}T23:59:59.999+09:00` }];
  return { range, orders, daily, syncRuns, connection: { merchant_id: 1, last_synced_at: '2026-09-14T00:00:00+09:00' } };
}
test('completed orders only, matched daily coverage and paid menu quantities', () => {
  const f = salesFixture();
  f.orders.push({ ...f.orders[13], state: 'CANCELLED', total_amount: 9999 }); f.daily[13].order_count++;
  const result = weeklySales(f.orders, f.daily, f.range, f.connection, f.syncRuns);
  assert.equal(result.comparable, true);
  assert.equal(result.current.revenue, 1400);
  assert.equal(result.current.orders, 7);
  assert.equal(result.current.average, 200);
  assert.equal(result.menus[0].name, '메뉴'); assert.equal(result.menus[0].quantity, 14); assert.equal(result.menus[0].previous, 7); assert.equal(result.menus[0].code, 'menu-1');
  assert.equal(JSON.stringify(result).includes('raw_order'), false);
});
test('missing days and incomplete pagination suppress comparisons instead of assuming zero', () => {
  const f = salesFixture();
  for (const [orders, daily, runs] of [[f.orders, f.daily.slice(1), f.syncRuns], [f.orders.slice(1), f.daily, f.syncRuns], [f.orders, f.daily, []]]) {
    const result = weeklySales(orders, daily, f.range, f.connection, runs);
    assert.equal(result.comparable, false);
    assert.equal(result.menus[0].previous, null);
  }
  f.orders[0].raw_order = {};
  const result = weeklySales(f.orders, f.daily, f.range, f.connection, f.syncRuns);
  assert.equal(result.comparable, true);
  assert.equal(result.menuComparable, false);
  assert.equal(result.menus[0].previous, null);
});
test('pagination reads past 1000 rows and propagates source failures', async () => {
  const seen = [];
  const rows = await readAll('rows?order=id', async path => { const offset = Number(new URL(`https://test/${path}`).searchParams.get('offset')); seen.push(offset); return Array.from({ length: offset < 1000 ? 500 : 3 }, (_, i) => offset + i); });
  assert.equal(rows.length, 1003); assert.deepEqual(seen, [0, 500, 1000]);
  await assert.rejects(readAll('rows?', async () => { throw Error('offline'); }), /offline/);
});
const org = '10000000-0000-0000-0000-000000000001';
const response = () => ({ statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; }, setHeader() {} });
test('API denies unauthenticated and delegated managers before financial queries', async t => {
  process.env.SUPABASE_URL = 'https://test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  const seen = [];
  t.mock.method(globalThis, 'fetch', async url => { seen.push(url); return new Response(JSON.stringify(url.includes('/auth/') ? { id: 'delegate' } : [{ id: org, owner_id: 'owner' }])); });
  let res = response(); await handler({ method: 'GET', headers: {}, query: { organizationId: org } }, res);
  assert.equal(res.statusCode, 401); assert.equal(seen.length, 0);
  res = response(); await handler({ method: 'GET', headers: { authorization: 'Bearer test' }, query: { organizationId: org, scope: 'tasks' } }, res);
  assert.equal(res.statusCode, 403); assert.equal(seen.length, 2);
  assert.equal(seen.some(url => /card|payroll|tossplace/.test(url)), false);
});
test('weekly sales requires an active delegated sales.view permission', async t => {
  process.env.SUPABASE_URL = 'https://test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  let allowed = false;
  t.mock.method(globalThis, 'fetch', async url => {
    let body = [];
    if (url.includes('/auth/')) body = { id: 'delegate' };
    else if (url.includes('organizations?')) body = [{ id: org, owner_id: 'owner' }];
    else if (url.includes('memberships?')) body = [{ organization_id: org }];
    else if (url.includes('management_accounts?')) body = [{ id: 'account-1' }];
    else if (url.includes('management_permissions?')) body = allowed ? [{ permission_code: 'sales.view' }] : [];
    return new Response(JSON.stringify(body));
  });
  let res = response();
  await handler({ method: 'GET', headers: { authorization: 'Bearer test' }, query: { organizationId: org, scope: 'weekly', from: 'invalid' } }, res);
  assert.equal(res.statusCode, 403);
  allowed = true; res = response();
  await handler({ method: 'GET', headers: { authorization: 'Bearer test' }, query: { organizationId: org, scope: 'weekly', from: 'invalid' } }, res);
  assert.equal(res.statusCode, 400);
});
test('owner receives date-scoped unreviewed card groups and a separate payroll snapshot', async t => {
  process.env.SUPABASE_URL = 'https://test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  const seen = [];
  t.mock.method(globalThis, 'fetch', async url => {
    seen.push(url);
    let body = [];
    if (url.includes('/auth/')) body = { id: 'owner' };
    else if (url.includes('organizations?')) body = [{ id: org, owner_id: 'owner' }];
    else if (url.includes('card_transaction_groups?')) body = [{ net_amount: 100 }, { net_amount: 250 }];
    else if (url.includes('payroll_drafts?')) body = [{ updated_at: '2026-09-12T00:00:00Z' }];
    else if (url.includes('attendance_records?')) body = [{ updated_at: '2026-09-16T00:00:00Z' }];
    return new Response(JSON.stringify(body));
  });
  const res = response(); await handler({ method: 'GET', headers: { authorization: 'Bearer test' }, query: { organizationId: org, scope: 'tasks', month: '2026-09' } }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.data.cardCount, 2); assert.equal(res.body.data.cardAmount, 350); assert.equal(res.body.data.attendanceChanged, true);
  const cardUrl = seen.find(url => url.includes('card_transaction_groups?'));
  assert.match(cardUrl, /reconciliation_status=eq.unreviewed/); assert.match(cardUrl, /net_amount=gt.0/); assert.match(cardUrl, /2026-10-01/);
});


test('corrections preserve seconds and reject future, reversed, missing checkout, and overlong shifts', () => {
  const input = { date: '2026-09-15', checkedIn: '2026-09-15T09:00:23', checkedOut: '2026-09-15T18:00:45', reason: '실근무 확인', requireCheckout: true };
  const now = new Date('2026-09-17T09:00:00+09:00');
  assert.equal(validAttendanceCorrection(input, now), true);
  for (const patch of [{ checkedOut: '' }, { checkedOut: '2026-09-15T08:00' }, { checkedOut: '2026-09-18T19:00' }, { checkedIn: '2026-09-16T09:00' }, { reason: ' ' }]) assert.equal(validAttendanceCorrection({ ...input, ...patch }, now), false);
});

test('weekly API accepts any completed seven-day range and rejects ranges including today', async t => {
  process.env.SUPABASE_URL = 'https://test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  const seen = [];
  t.mock.method(globalThis, 'fetch', async url => {
    seen.push(url);
    return new Response(JSON.stringify(url.includes('/auth/') ? { id: 'owner' } : [{ id: org, owner_id: 'owner' }]));
  });
  for (const from of ['2026-02-30', addDays(recentCompletedWeek().from, 1)]) {
    const res = response();
    await handler({ method: 'GET', headers: { authorization: 'Bearer test' }, query: { organizationId: org, from } }, res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(seen.some(url => url.includes('tossplace')), false);
});

test('weekly API scopes every order and cache read by both organization and connected merchant', async t => {
  process.env.SUPABASE_URL = 'https://test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  const f = salesFixture(), seen = [];
  t.mock.method(globalThis, 'fetch', async url => {
    seen.push(url);
    let body;
    if (url.includes('/auth/')) body = { id: 'owner' };
    else if (url.includes('organizations?')) body = [{ id: org, owner_id: 'owner' }];
    else if (url.includes('connections?')) body = [f.connection];
    else if (url.includes('daily_sales?')) body = f.daily;
    else if (url.includes('sales_sync_runs?')) body = f.syncRuns;
    else if (url.includes('tossplace_orders?')) body = f.orders;
    else throw new Error('Unexpected data access');
    return new Response(JSON.stringify(body));
  });
  const res = response();
  await handler({ method: 'GET', headers: { authorization: 'Bearer test' }, query: { organizationId: org, from: f.range.from } }, res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.data.current.revenue, 1400);
  for (const url of seen.filter(url => /daily_sales\?|tossplace_orders\?/.test(url))) {
    assert.match(url, new RegExp(`organization_id=eq.${org}`)); assert.match(url, /merchant_id=eq.1/);
  }
  const ordersUrl = new URL(seen.find(url => url.includes('tossplace_orders?')));
  assert.equal(ordersUrl.searchParams.get('ordered_at'), 'gte.2026-09-03T00:00:00+09:00');
  assert.deepEqual(ordersUrl.searchParams.getAll('ordered_at'), ['gte.2026-09-03T00:00:00+09:00', 'lt.2026-09-17T00:00:00+09:00']);
  assert.equal(JSON.stringify(res.body).includes('raw_order'), false);
});

test('source failures return an error, never a successful zero-card result', async t => {
  process.env.SUPABASE_URL = 'https://test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.includes('/auth/')) return new Response(JSON.stringify({ id: 'owner' }));
    if (url.includes('organizations?')) return new Response(JSON.stringify([{ id: org, owner_id: 'owner' }]));
    return new Response(JSON.stringify({ message: 'private upstream detail' }), { status: 503 });
  });
  const res = response();
  await handler({ method: 'GET', headers: { authorization: 'Bearer test' }, query: { organizationId: org, scope: 'tasks' } }, res);
  assert.equal(res.statusCode, 502); assert.equal(res.body.ok, false); assert.equal(res.body.data, undefined);
  assert.equal(JSON.stringify(res.body).includes('private upstream detail'), false);
});
