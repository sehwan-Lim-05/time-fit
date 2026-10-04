export const costRate = (cost, sales) => Number(sales) > 0 ? Number(cost || 0) / Number(sales) : null;

export function financeCostOverview(totals = {}, purchaseTotals = totals) {
  return [
    { key: 'kitchenPurchases', label: '주방 구매비', amount: Number(purchaseTotals.kitchenPurchases || 0), rate: costRate(purchaseTotals.kitchenPurchases, purchaseTotals.netSales), basis: '실적 매출 기준 · 분류된 확정 지출' },
    { key: 'hallPurchases', label: '홀 구매비', amount: Number(purchaseTotals.hallPurchases || 0), rate: costRate(purchaseTotals.hallPurchases, purchaseTotals.netSales), basis: '실적 매출 기준 · 분류된 확정 지출' },
    { key: 'laborCost', label: '총 인건비', amount: Number(totals.laborCost || 0), rate: costRate(totals.laborCost, totals.netSales), basis: '급여 초안 배분' },
    { key: 'operatingExpenses', label: '운영지출', amount: Number(totals.operatingExpenses || 0), rate: costRate(totals.operatingExpenses, totals.netSales), basis: '확정·잠정·자동 계산 포함' },
  ];
}
