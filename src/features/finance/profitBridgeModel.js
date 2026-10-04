export function buildProfitBridge(totals = {}) {
  const sales = Number(totals.netSales || 0);
  const expenses = Number(totals.operatingExpenses || 0);
  const labor = Number(totals.laborCost || 0);
  const profit = sales - expenses - labor;
  const scale = Math.max(1, Math.abs(sales), Math.abs(profit), Math.abs(expenses), Math.abs(labor));
  return {
    sales, expenses, labor, profit, scale,
    steps: [
      { key: 'sales', label: '순매출', value: sales, remaining: sales },
      { key: 'expenses', label: '운영지출', value: expenses, remaining: sales - expenses },
      { key: 'labor', label: '인건비', value: labor, remaining: profit },
      { key: 'profit', label: '운영순익', value: profit, remaining: profit },
    ],
  };
}
