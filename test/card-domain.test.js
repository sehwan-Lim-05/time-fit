import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOperatingProfit, deduplicateCardEvents, summarizeCardEvents } from '../src/features/finance/cardDomain.js';
import { mockCardProvider } from '../src/features/finance/mockCardProvider.js';
import { cardProvider, mockServerCardProvider } from '../server/api/providers/mock-card-provider.js';

test('동일 provider 이벤트를 재수집해도 한 번만 계산한다', async () => {
  const events = await mockCardProvider.fetchEvents();
  const duplicated = [...events, ...events];
  assert.equal(deduplicateCardEvents(duplicated).length, 3);
  assert.deepEqual(summarizeCardEvents(duplicated), {
    approvedAmount: 120000,
    acquiredAmount: 120000,
    cancelledAmount: 20000,
    billedAmount: null,
    netAmount: 100000,
    status: 'partially_cancelled',
    eventCount: 3,
  });
});

test('전체 취소는 순액 0원과 cancelled 상태가 된다', () => {
  const common = { organizationId: 'org', provider: 'mock', occurredAt: '2026-09-10T09:00:00+09:00' };
  const result = summarizeCardEvents([
    { ...common, providerEventId: 'a', eventType: 'approval', amount: 50000 },
    { ...common, providerEventId: 'c', eventType: 'cancellation', amount: 50000 },
  ]);
  assert.equal(result.netAmount, 0);
  assert.equal(result.status, 'cancelled');
});

test('운영순익은 순매출에서 확정 운영지출과 실제 인건비를 뺀다', () => {
  assert.equal(calculateOperatingProfit({ netSales: 1000000, confirmedOperatingExpenses: 280000, actualLaborCost: 320000 }), 400000);
});

test('서버 Mock Provider가 카드 발견과 백필 계약을 제공한다', async () => {
  assert.equal(cardProvider('mock'), mockServerCardProvider);
  const cards = await mockServerCardProvider.listCards();
  const events = await mockServerCardProvider.fetchEvents({ organizationId: 'org' });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].last4, '4821');
  assert.deepEqual(events.map(event => event.eventType), ['approval','partial_cancellation','acquisition']);
  assert.throws(() => cardProvider('hyphen'), /provider_not_available/);
});
