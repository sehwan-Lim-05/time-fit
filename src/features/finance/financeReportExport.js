const csvCell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const laborLabels = { attendance_weighted_payroll_draft: '실제 근태 가중 급여 초안', mixed_attendance_and_calendar_fallback: '근태 가중·달력 일할 혼합', calendar_daily_fallback: '달력 일할 추정' };

export function financeReportCsvRows({ report, periodType }) {
  const completeness = report?.completeness || {}; const audit = report?.audit || {};
  return [
    ['보고서 정보','값','','','',''],
    ['기간',`${report.from}~${report.to}`,'','','',''],
    ['상태',audit.status === 'closed' ? `확정 · 버전 ${audit.version}` : '미확정 미리보기','','','',''],
    ['확정자',audit.closedByName || '-','','','',''],
    ['확정 시각',audit.closedAt || '-','','','',''],
    ['데이터 기준 시각',audit.sourceCutoffAt || audit.generatedAt || '-','','','',''],
    ['증빙률',`${completeness.evidenceRate ?? 0}%`,'미증빙 확정지출',(completeness.confirmedExpenses || 0) - (completeness.evidencedExpenses || 0),'미대사 카드',completeness.unresolvedCardTransactions || 0],
    ['카드 연결 상태',completeness.cardSyncHealthy === false ? `확인 필요 ${completeness.unhealthyConnections || 0}건` : '정상','인건비 기준',laborLabels[completeness.laborBasis] || completeness.laborBasis || '-','',''],
    ['확정 지출 카테고리별 합계',...Object.entries(report.actualTotals?.categoryBreakdown || report.totals.categoryBreakdown || {}).flatMap(([category, amount]) => [category, amount])],
    ['카드수수료',report.totals.cardFees || 0,'매출연동 임대료',report.totals.rentExpense || 0,'평균 주문단가',report.totals.averageOrderValue || 0],
    ['운영지출 · 잠정 포함',report.totals.operatingExpenses || 0,'증빙 확정 지출',report.totals.confirmedExpenses || 0,'미증빙 카드 지출',report.totals.provisionalCardExpenses || 0],
    ['자동 계산 비용',report.totals.calculatedExpenses || 0,'카드수수료',report.totals.cardFees || 0,'매출연동 임대료',report.totals.rentExpense || 0],
    ['현재 실적 순매출',report.actualTotals?.netSales ?? report.totals.netSales,'현재 실적 순익',report.actualTotals?.operatingProfit ?? report.totals.operatingProfit,'미래 예상 지출',report.totals.forecastExpenses || 0],
    ['예측 기준',report.hasForecast ? `완료 영업일 ${report.forecast?.baselineDays || 0}일 요일별 평균` : '예측 없음','실제 변동지출률',`${report.forecast?.variableExpenseRate || 0}%`,'실적 기준일',report.asOfDate || report.to],
    ['순익 판정',completeness.payrollComplete === false ? '잠정 · 급여 초안 미수록, 인건비 0원 반영' : completeness.payrollComplete === true ? '급여 초안 반영' : '인건비 반영 상태 미확인','','','',''],
    [],
    ['기간유형','날짜','구분','순매출','운영지출(잠정 포함)','증빙 확정 지출','미증빙 카드 지출','미래 예상 지출','자동 계산 비용','인건비','운영순익'],
    ['합계',`${report.from}~${report.to}`,report.hasForecast ? '기간 말 예상' : '실적',report.totals.netSales,report.totals.operatingExpenses,report.totals.confirmedExpenses,report.totals.provisionalCardExpenses,report.totals.forecastExpenses,report.totals.calculatedExpenses,report.totals.laborCost,report.totals.operatingProfit],
    ...(report?.displaySeries || report?.series || []).map(item => [periodType,item.date,item.dataStatus === 'forecast' ? '예상' : item.dataStatus === 'in_progress' ? '진행 중' : '실적',item.sales ?? item.netSales,item.operatingExpenses,item.confirmedExpenses,item.provisionalCardExpenses,item.forecastExpenses,item.calculatedExpenses,item.laborCost,item.operatingProfit]),
  ];
}

export function downloadFinanceReportCsv({ report, periodType }) {
  const rows = financeReportCsvRows({ report, periodType });
  const url = URL.createObjectURL(new Blob([`\ufeff${rows.map(row => row.map(csvCell).join(',')).join('\n')}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `timefit-finance-${periodType}.csv`; link.click(); URL.revokeObjectURL(url);
}

export function openFinanceReportPrint({ report, periodType }) {
  const popup = window.open('', '_blank'); if (!popup) return false;
  const totals = report?.totals || {}; const completeness = report?.completeness || {}; const audit = report?.audit || {}; const won = value => `${Math.round(Number(value)||0).toLocaleString('ko-KR')}원`;
  const status = audit.status === 'closed' ? `확정 · 버전 ${audit.version}` : '미확정 미리보기';
  popup.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>TimeFit 운영손익</title><style>body{font-family:sans-serif;padding:32px;color:#191f28}h1{margin-bottom:24px}.cards,.audit{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}.cards div,.audit div{padding:18px;border:1px solid #ddd;border-radius:12px}.cards b,.audit b{display:block;margin-top:8px;font-size:20px}.audit b{font-size:13px}@media print{button{display:none}}</style></head><body><h1>운영손익 · ${escapeHtml(periodType)}</h1><div class="cards"><div>순매출<b>${won(totals.netSales)}</b></div><div>운영지출 · 잠정 포함<b>${won(totals.operatingExpenses)}</b></div><div>인건비<b>${won(totals.laborCost)}</b></div><div>운영순익<b>${won(totals.operatingProfit)}</b></div></div><div class="audit"><div>결산 상태<b>${escapeHtml(status)}</b></div><div>증빙 확정 지출<b>${won(totals.confirmedExpenses)}</b></div><div>미증빙 카드 지출<b>${won(totals.provisionalCardExpenses)}</b></div><div>자동 계산 비용<b>${won(totals.calculatedExpenses)}</b></div></div><div class="audit"><div>확정자·시각<b>${escapeHtml(audit.closedByName || '-')} · ${escapeHtml(audit.closedAt ? new Date(audit.closedAt).toLocaleString('ko-KR') : '-')}</b></div><div>증빙·카드 대사<b>${escapeHtml(completeness.evidenceRate ?? 0)}% · 미대사 ${escapeHtml(completeness.unresolvedCardTransactions || 0)}건</b></div><div>카드 연결·인건비 기준<b>${completeness.cardSyncHealthy === false ? `확인 필요 ${escapeHtml(completeness.unhealthyConnections || 0)}건` : '정상'} · ${escapeHtml(laborLabels[completeness.laborBasis] || '-')}</b></div></div><p>데이터 기준 시각: ${escapeHtml(audit.sourceCutoffAt || audit.generatedAt || '-')}</p><button onclick="window.print()">PDF 저장 · 인쇄</button></body></html>`); popup.document.close(); return true;
}
