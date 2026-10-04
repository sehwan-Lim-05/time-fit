import test from 'node:test';
import assert from 'node:assert/strict';
import { dailySalesSyncRange, normalizeSalesSyncRange } from '../server/api/sync-sales.js';

test('기간 동기화 날짜를 한국시간 API 범위로 변환한다', () => {
  assert.deepEqual(normalizeSalesSyncRange('2026-09-01', '2026-09-30'), {
    from: '2026-08-31T15:00:00.000Z',
    to: '2026-09-30T14:59:59.999Z',
  });
});

test('오후 10시 자동 수집은 지연 실행돼도 당일 22시를 넘지 않는다', () => {
  const cutoff = { from: '2026-09-13T15:00:00.000Z', to: '2026-09-15T13:00:00.000Z' };
  assert.deepEqual(dailySalesSyncRange(new Date('2026-09-15T13:00:00.000Z')), cutoff);
  assert.deepEqual(dailySalesSyncRange(new Date('2026-09-15T13:27:00.000Z')), cutoff);
});

test('22시 전 자동 수집은 미래 주문을 요청하지 않는다', () => {
  assert.deepEqual(dailySalesSyncRange(new Date('2026-09-15T12:30:00.000Z')), {
    from: '2026-09-13T15:00:00.000Z',
    to: '2026-09-15T12:30:00.000Z',
  });
});

test('불완전하거나 역전되고 너무 긴 기간을 거부한다', () => {
  assert.throws(() => normalizeSalesSyncRange('2026-09-01', null), /시작일과 종료일/);
  assert.throws(() => normalizeSalesSyncRange('2026-10-01', '2026-09-30'), /기간을 확인/);
  assert.throws(() => normalizeSalesSyncRange('2025-01-01', '2026-09-30'), /최대 1년/);
});
