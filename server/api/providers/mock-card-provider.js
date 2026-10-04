const MOCK_CARD_ID = 'mock-card-butter-villa-4821';

export const mockServerCardProvider = Object.freeze({
  provider: 'mock',
  async authenticate() {
    return { credentialReference: null, expiresAt: null };
  },
  async listCards() {
    return [{ providerAssetId: MOCK_CARD_ID, issuer: 'TimeFit 테스트카드', displayName: '매장 운영비 카드', last4: '4821', status: 'active' }];
  },
  async fetchEvents({ organizationId }) {
    const events = [
      { providerEventId: 'mock-approval-001', groupKey: 'mock-group-001', eventType: 'approval', occurredAt: '2026-09-10T09:30:00+09:00', amount: 120000, currency: 'KRW', approvalNumber: '100001', merchantName: '식자재마트', organizationId },
      { providerEventId: 'mock-cancel-001', originalProviderEventId: 'mock-approval-001', groupKey: 'mock-group-001', eventType: 'partial_cancellation', occurredAt: '2026-09-10T10:10:00+09:00', amount: 20000, currency: 'KRW', approvalNumber: '100001', merchantName: '식자재마트', organizationId },
      { providerEventId: 'mock-acquisition-001', originalProviderEventId: 'mock-approval-001', groupKey: 'mock-group-001', eventType: 'acquisition', occurredAt: '2026-09-11T03:00:00+09:00', amount: 120000, currency: 'KRW', approvalNumber: '100001', merchantName: '식자재마트', organizationId },
    ]; events.nextCursor = 'mock-cursor-001'; return events;
  },
});

export function cardProvider(name) {
  if (name === 'mock') return mockServerCardProvider;
  throw new Error('provider_not_available');
}
