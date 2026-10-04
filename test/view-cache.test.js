import test from 'node:test';
import assert from 'node:assert/strict';
import { invalidateViewCache, readViewCache, writeViewCache } from '../src/lib/viewCache.js';

test('화면 캐시는 계정·사업장별로 분리되고 만료·무효화된다', () => {
  writeViewCache('payroll:owner:store:2026-09', { total: 10 }, 1000);
  writeViewCache('payroll:other:store:2026-09', { total: 20 }, 1000);
  assert.deepEqual(readViewCache('payroll:owner:store:2026-09', 2000), { total: 10 });
  invalidateViewCache('payroll:owner:store:');
  assert.equal(readViewCache('payroll:owner:store:2026-09', 2000), null);
  assert.equal(readViewCache('payroll:other:store:2026-09', 31000), null);
});

test('화면별로 더 긴 캐시 유지 시간을 적용할 수 있다', () => {
  writeViewCache('expense-review:owner:store:attention:all', [{ id: 'receipt-1' }], 1000);
  assert.deepEqual(readViewCache('expense-review:owner:store:attention:all', 121000, 300000), [{ id: 'receipt-1' }]);
  assert.equal(readViewCache('expense-review:owner:store:attention:all', 301000, 300000), null);
});
