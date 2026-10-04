import { financeCostOverview } from './financeCostOverview';

const won = value => `${Math.round(Number(value) || 0).toLocaleString('ko-KR')}원`;
const filePeriod = report => `${report.from}_${report.to}`;
const reportRows = report => report?.displaySeries || report?.series || [];

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function profitChartDataUrl(rows, width = 1200, height = 420) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  const padding = { left: 95, right: 30, top: 35, bottom: 55 };
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  const values = rows.map(row => Number(row.operatingProfit || 0));
  const max = Math.max(1, ...values.map(Math.abs));
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const zeroY = padding.top + plotHeight / 2;
  context.strokeStyle = '#dbe4f0';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(padding.left, zeroY);
  context.lineTo(width - padding.right, zeroY);
  context.stroke();
  context.fillStyle = '#64748b';
  context.font = '22px sans-serif';
  context.textAlign = 'right';
  context.fillText(`+${won(max)}`, padding.left - 12, padding.top + 8);
  context.fillText('0', padding.left - 12, zeroY + 8);
  context.fillText(`-${won(max)}`, padding.left - 12, height - padding.bottom + 8);
  if (rows.length) {
    const points = rows.map((row, index) => ({ x: padding.left + (rows.length === 1 ? plotWidth / 2 : index * plotWidth / (rows.length - 1)), y: zeroY - Number(row.operatingProfit || 0) / max * (plotHeight / 2) }));
    const firstForecast = rows.findIndex(row => row.dataStatus === 'forecast');
    const line = (part, color, dashed = false) => {
      if (part.length < 2) return;
      context.strokeStyle = color; context.lineWidth = 5; context.lineJoin = 'round'; context.setLineDash(dashed ? [12, 8] : []); context.beginPath();
      part.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
      context.stroke(); context.setLineDash([]);
    };
    line(firstForecast < 0 ? points : points.slice(0, firstForecast), '#2f80ed');
    if (firstForecast >= 0) line(points.slice(Math.max(0, firstForecast - 1)), '#8b5cf6', true);
    context.fillStyle = '#475569'; context.font = '18px sans-serif'; context.textAlign = 'right';
    context.fillText(firstForecast >= 0 ? '실적 —   예상 - - -' : '실적 —', width - padding.right, padding.top + 12);
    context.fillStyle = '#334155';
    context.font = '22px sans-serif';
    context.textAlign = 'left';
    context.fillText(rows[0].date, padding.left, height - 15);
    context.textAlign = 'right';
    context.fillText(rows.at(-1).date, width - padding.right, height - 15);
  }
  return canvas.toDataURL('image/png');
}

export async function downloadFinanceReportXlsx({ report, periodType }) {
  const module = await import('exceljs');
  const ExcelJS = module.default || module;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TimeFit';
  workbook.created = new Date();
  const summary = workbook.addWorksheet('손익 요약', { views: [{ showGridLines: false }] });
  summary.columns = [{ width: 23 }, { width: 22 }, { width: 23 }, { width: 22 }, { width: 23 }, { width: 22 }];
  summary.addRow(['TimeFit 운영손익 보고서']);
  summary.mergeCells('A1:F1');
  summary.getCell('A1').font = { size: 20, bold: true, color: { argb: 'FF172033' } };
  summary.getRow(1).height = 34;
  summary.addRow([`${report.from} ~ ${report.to}`, '', '', '', '', '']);
  summary.mergeCells('A2:F2');
  summary.getCell('A2').font = { color: { argb: 'FF64748B' } };
  summary.addRow([]);
  summary.addRow([report.hasForecast ? '예상 순매출' : '순매출', report.totals.netSales, '운영지출 · 잠정 포함', report.totals.operatingExpenses, '인건비', report.totals.laborCost]);
  summary.addRow([report.hasForecast ? '예상 운영순익' : '운영순익', report.totals.operatingProfit, '순익률', report.totals.profitMargin === null ? null : report.totals.profitMargin / 100, '증빙 확정 지출', report.totals.confirmedExpenses || 0]);
  summary.addRow(['미증빙 카드 지출', report.totals.provisionalCardExpenses || 0, '자동 계산 비용', report.totals.calculatedExpenses || 0, '미래 예상 지출', report.totals.forecastExpenses || 0]);
  ['A4','C4','E4','A5','C5','E5','A6','C6','E6'].forEach(cell => {
    summary.getCell(cell).font = { bold: true, color: { argb: 'FF475569' } };
    summary.getCell(cell).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
  });
  ['B4','D4','F4','B5','F5','B6','D6','F6'].forEach(cell => {
    summary.getCell(cell).numFmt = '#,##0"원";[Red]-#,##0"원"';
    summary.getCell(cell).font = { bold: true };
  });
  summary.getCell('D5').numFmt = '0.0%';
  summary.addRow([]);
  summary.addRow(['현재 실적 순매출', report.actualTotals?.netSales ?? report.totals.netSales, '현재 실적 순익', report.actualTotals?.operatingProfit ?? report.totals.operatingProfit, '예측 기준', report.hasForecast ? `완료 ${report.forecast?.baselineDays || 0}일 요일별 평균` : '예측 없음']);
  summary.addRow(['증빙률', (report.completeness?.evidenceRate || 0) / 100, '미대사 카드', report.completeness?.unresolvedCardTransactions || 0, '결산 상태', report.audit?.status === 'closed' ? '확정' : '미확정 미리보기']);
  ['B8','D8'].forEach(cell => { summary.getCell(cell).numFmt = '#,##0"원";[Red]-#,##0"원"'; });
  summary.getCell('B9').numFmt = '0.0%';
  summary.getCell('A10').value = '재고 실사용 원가·홀/주방 인건비 분리 미연동 · 실적과 예상은 비용 대사 시 구분';
  summary.mergeCells('A10:F10');
  summary.getCell('A10').font = { size: 10, color: { argb: 'FF9A6700' } };
  const rows = reportRows(report);
  const chartImage = workbook.addImage({ base64: profitChartDataUrl(rows), extension: 'png' });
  summary.addImage(chartImage, { tl: { col: 0, row: 10 }, ext: { width: 900, height: 315 } });
  const cost = workbook.addWorksheet('비용·인건비', { views: [{ state: 'frozen', ySplit: 4, showGridLines: false }] });
  cost.columns = [{ width: 30 }, { width: 20 }, { width: 20 }, { width: 20 }, { width: 20 }, { width: 18 }, { width: 31 }];
  cost.addRow(['손익 구성 · 같은 기간과 같은 산식']);
  cost.mergeCells('A1:G1');
  cost.getCell('A1').font = { size: 17, bold: true, color: { argb: 'FF172033' } };
  cost.addRow([`${report.from} ~ ${report.to} · 실적 기준 ${report.asOfDate || report.to}`]);
  cost.mergeCells('A2:G2');
  cost.getCell('A2').font = { color: { argb: 'FF64748B' } };
  cost.addRow([]);
  cost.addRow(['항목', '현재 실적', '미래 예상', '기간 합계', '보고서 합계', '차이', '산정 기준']);
  const costItems = [
    ['netSales', '순매출', '완료 주문 매출 / 요일별 예상'],
    ...Object.entries(report.actualTotals?.categoryBreakdown || report.totals?.categoryBreakdown || {}).map(([category]) => [`category:${category}`, category, '확정 지출 카테고리별 합계']),
    ['confirmedExpenses', '증빙 확정 지출', '지출 원장'],
    ['provisionalCardExpenses', '미증빙 카드 지출', '잠정 반영 · 확정 후 중복 제외'],
    ['forecastExpenses', '미래 예상 변동지출', '실적 변동지출률 적용'],
    ['cardFees', '카드수수료', `매출 × ${(Number(report.assumptions?.cardFeeRate || 0) * 100).toFixed(1)}%`],
    ['rentExpense', '매출연동 임대료', `매출 × ${(Number(report.assumptions?.revenueRentRate || 0) * 100).toFixed(1)}%`],
    ['calculatedExpenses', '자동 계산 비용', '카드수수료 + 매출연동 임대료'],
    ['operatingExpenses', '운영지출', '확정 + 미증빙 카드 + 미래 예상 + 자동 계산'],
    ['laborCost', '총 인건비', '급여 초안의 기간 배분'],
    ['operatingProfit', '운영순익', '순매출 − 운영지출 − 인건비'],
  ];
  costItems.forEach(([key, label, basis]) => {
    const index = cost.lastRow.number + 1;
    const category = key.startsWith('category:') ? key.slice(9) : null;
    const actualValue = category ? Number((report.actualTotals?.categoryBreakdown || report.totals?.categoryBreakdown || {})[category] || 0) : Number((report.actualTotals || report.totals)?.[key] || 0);
    const forecastValue = category ? 0 : Number(report.forecastTotals?.[key] || 0);
    const totalValue = category ? Number(report.totals?.categoryBreakdown?.[category] || actualValue) : Number(report.totals?.[key] || 0);
    const row = cost.addRow([label, actualValue, forecastValue, null, totalValue, null, basis]);
    row.getCell(4).value = { formula: `B${index}+C${index}`, result: totalValue };
    row.getCell(6).value = { formula: `D${index}-E${index}`, result: 0 };
  });
  const rateStart = cost.lastRow.number + 2;
  cost.getCell(`A${rateStart}`).value = '매출 대비 코스트율';
  cost.getCell(`A${rateStart}`).font = { bold: true, color: { argb: 'FF26364D' } };
  const rateRows = [];
  financeCostOverview(report.totals, report.actualTotals || report.totals).forEach(item => {
    const row = cost.addRow([`${item.label} 코스트`, null, null, null, item.rate, null, item.basis]);
    rateRows.push(row.number);
  });
  cost.addRow(['연결 범위', '재고 실사용 원가', '미연동', '홀·주방 인건비', '미분리', '', '누락 항목을 0원으로 해석하지 마세요']);
  cost.getRow(4).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  cost.getRow(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF26364D' } };
  cost.getRow(4).alignment = { horizontal: 'center' };
  [2,3,4,5,6].forEach(column => { cost.getColumn(column).numFmt = '#,##0"원";[Red]-#,##0"원"'; });
  rateRows.forEach(index => { cost.getCell(`E${index}`).numFmt = '0.0%'; });
  cost.getColumn(7).alignment = { wrapText: true, vertical: 'middle' };
  cost.eachRow((row, index) => { if (index > 4 && index % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }; if (index > 3) row.height = 24; });
  const detail = workbook.addWorksheet('기간별 손익', { views: [{ state: 'frozen', ySplit: 1 }] });
  detail.columns = [
    { header: '기간', key: 'date', width: 16 }, { header: '구분', key: 'status', width: 12 }, { header: '순매출', key: 'sales', width: 18 },
    { header: '운영지출(잠정 포함)', key: 'expenses', width: 22 }, { header: '증빙 확정 지출', key: 'confirmed', width: 18 },
    { header: '미증빙 카드 지출', key: 'provisional', width: 19 }, { header: '미래 예상 지출', key: 'forecast', width: 18 }, { header: '자동 계산 비용', key: 'calculated', width: 18 },
    { header: '인건비', key: 'labor', width: 18 }, { header: '운영순익', key: 'profit', width: 18 }, { header: '순익률', key: 'margin', width: 13 },
  ];
  rows.forEach(row => detail.addRow({ date: row.date, status: row.dataStatus === 'forecast' ? '예상' : row.dataStatus === 'in_progress' ? '진행 중' : '실적', sales: row.sales ?? row.netSales, expenses: row.operatingExpenses, confirmed: row.confirmedExpenses, provisional: row.provisionalCardExpenses, forecast: row.forecastExpenses, calculated: row.calculatedExpenses, labor: row.laborCost, profit: row.operatingProfit, margin: row.sales ? row.operatingProfit / row.sales : null }));
  detail.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  detail.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF26364D' } };
  detail.getRow(1).alignment = { horizontal: 'center' };
  detail.getColumn(1).alignment = { horizontal: 'center' };
  [3,4,5,6,7,8,9,10].forEach(index => { detail.getColumn(index).numFmt = '#,##0"원";[Red]-#,##0"원"'; });
  detail.getColumn(11).numFmt = '0.0%';
  detail.eachRow((row, index) => {
    if (index > 1 && index % 2 === 1) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    row.height = 22;
  });
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `timefit-finance-${filePeriod(report)}.xlsx`);
}

export async function downloadFinanceReportPdf({ report, periodType }) {
  const { PDFDocument } = await import('pdf-lib');
  const pdfDocument = await PDFDocument.create();
  const pageSize = [841.89, 595.28];
  const rows = reportRows(report);
  const canvasSize = [1684, 1190];
  const makeCanvas = () => {
    const canvas = document.createElement('canvas');
    [canvas.width, canvas.height] = canvasSize;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.textBaseline = 'alphabetic';
    return { canvas, context };
  };
  const drawText = (context, value, x, y, size = 20, color = '#172033', weight = 400, align = 'left') => {
    context.fillStyle = color;
    context.font = `${weight} ${size}px "Noto Sans KR", "Apple SD Gothic Neo", sans-serif`;
    context.textAlign = align;
    context.fillText(String(value ?? ''), x, y);
  };
  const appendCanvas = async canvas => {
    const image = await pdfDocument.embedPng(canvas.toDataURL('image/png'));
    const page = pdfDocument.addPage(pageSize);
    page.drawImage(image, { x: 0, y: 0, width: pageSize[0], height: pageSize[1] });
  };
  const { canvas: coverCanvas, context } = makeCanvas();
  drawText(context, 'TimeFit 운영손익 보고서', 84, 94, 44, '#172033', 700);
  drawText(context, `${report.from} ~ ${report.to} · ${periodType}`, 84, 138, 20, '#64748b');
  const metrics = [[report.hasForecast?'예상 순매출':'순매출',report.totals.netSales],['운영지출(잠정 포함)',report.totals.operatingExpenses],['인건비',report.totals.laborCost],[report.hasForecast?'예상 운영순익':'운영순익',report.totals.operatingProfit]];
  metrics.forEach(([label,value], index) => {
    const x = 84 + index * 386;
    context.fillStyle = '#eef3f8';
    context.fillRect(x, 170, 356, 108);
    drawText(context, label, x + 24, 215, 18, '#64748b', 600);
    drawText(context, won(value), x + 24, 258, 30, '#172033', 700);
  });
  drawText(context, `현재 실적 · 매출 ${won(report.actualTotals?.netSales ?? report.totals.netSales)} · 순익 ${won(report.actualTotals?.operatingProfit ?? report.totals.operatingProfit)} / ${report.hasForecast ? `기간 말 예상 · 완료 ${report.forecast?.baselineDays || 0}일 요일별 평균` : '예측 없음'}`, 84, 310, 17, '#475569', 600);
  drawText(context, `지출 구성 · 확정 ${won(report.totals.confirmedExpenses || 0)} · 미증빙 ${won(report.totals.provisionalCardExpenses || 0)} · 미래 예상 ${won(report.totals.forecastExpenses || 0)} · 자동 계산 ${won(report.totals.calculatedExpenses || 0)}`, 84, 340, 16, '#64748b');
  drawText(context, '기간별 운영순익 추이', 84, 380, 26, '#172033', 700);
  const chart = { x: 124, y: 445, width: 1460, height: 390 };
  context.strokeStyle = '#dbe4f0'; context.lineWidth = 2;
  context.beginPath(); context.moveTo(chart.x, chart.y + chart.height / 2); context.lineTo(chart.x + chart.width, chart.y + chart.height / 2); context.stroke();
  const max = Math.max(1, ...rows.map(row => Math.abs(Number(row.operatingProfit || 0))));
  const points = rows.map((row,index) => ({ x: chart.x + (rows.length === 1 ? chart.width / 2 : index * chart.width / (rows.length - 1)), y: chart.y + chart.height / 2 - Number(row.operatingProfit || 0) / max * chart.height * 0.43 }));
  const firstForecast = rows.findIndex(row => row.dataStatus === 'forecast');
  const drawLine = (linePoints, color, dashed = false) => { if (!linePoints.length) return; context.strokeStyle = color; context.lineWidth = 5; context.lineJoin = 'round'; context.setLineDash(dashed ? [14,10] : []); context.beginPath(); linePoints.forEach((point,index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)); context.stroke(); context.setLineDash([]); };
  drawLine(firstForecast < 0 ? points : points.slice(0, firstForecast), '#2f80ed');
  if (firstForecast >= 0) drawLine(points.slice(Math.max(0, firstForecast - 1)), '#8b5cf6', true);
  points.forEach((point,index) => { context.fillStyle = rows[index]?.dataStatus === 'forecast' ? '#8b5cf6' : '#2f80ed'; context.beginPath(); context.arc(point.x, point.y, 4.5, 0, Math.PI * 2); context.fill(); });
  drawText(context, `+${won(max)}`, 84, chart.y + 12, 16, '#64748b', 400, 'right');
  drawText(context, '0', 84, chart.y + chart.height / 2 + 5, 16, '#64748b', 400, 'right');
  drawText(context, `-${won(max)}`, 84, chart.y + chart.height, 16, '#64748b', 400, 'right');
  if (rows.length) {
    drawText(context, rows[0].date, chart.x, 874, 16, '#64748b');
    drawText(context, rows.at(-1).date, chart.x + chart.width, 874, 16, '#64748b', 400, 'right');
  }
  drawText(context, '세부 내역은 다음 페이지에서 확인할 수 있습니다.', 84, 940, 18, '#64748b');
  await appendCanvas(coverCanvas);
  const columns = [{ label:'기간 · 구분',x:84 },{ label:'순매출',x:294 },{ label:'운영지출',x:578 },{ label:'인건비',x:862 },{ label:'운영순익',x:1146 },{ label:'순익률',x:1430 }];
  const perPage = 20;
  for (let offset = 0; offset < rows.length; offset += perPage) {
    const { canvas, context: tableContext } = makeCanvas();
    drawText(tableContext, '기간별 손익표', 84, 94, 36, '#172033', 700);
    drawText(tableContext, `${report.from} ~ ${report.to}`, 84, 134, 18, '#64748b');
    tableContext.fillStyle = '#26364d'; tableContext.fillRect(84, 170, 1516, 48);
    columns.forEach(column => drawText(tableContext, column.label, column.x + 12, 202, 18, '#ffffff', 700));
    rows.slice(offset, offset + perPage).forEach((row,index) => {
      const y = 258 + index * 42;
      if (index % 2 === 0) { tableContext.fillStyle = '#f8fafc'; tableContext.fillRect(84, y - 29, 1516, 42); }
      const margin = row.sales ? `${Math.round(row.operatingProfit / row.sales * 1000) / 10}%` : '-';
      const values = [`${row.date} · ${row.dataStatus === 'forecast' ? '예상' : row.dataStatus === 'in_progress' ? '진행 중' : '실적'}`,won(row.sales ?? row.netSales),won(row.operatingExpenses),won(row.laborCost),won(row.operatingProfit),margin];
      values.forEach((value,columnIndex) => drawText(tableContext,value,columns[columnIndex].x+12,y,17,columnIndex===4&&Number(row.operatingProfit)<0?'#cc1f1f':'#172033'));
    });
    drawText(tableContext, `${offset / perPage + 2} / ${Math.ceil(rows.length / perPage) + 1}`, 1576, 1140, 16, '#64748b', 400, 'right');
    await appendCanvas(canvas);
  }
  const bytes = await pdfDocument.save();
  downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `timefit-finance-${filePeriod(report)}.pdf`);
}
