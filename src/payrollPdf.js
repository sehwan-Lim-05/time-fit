const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const won = value => `${Math.round(Number(value) || 0).toLocaleString('ko-KR')}원`;
const minutes = value => { const total = Math.max(0, Math.round(Number(value) || 0)); return `${Math.floor(total / 60)}시간 ${total % 60}분`; };
const payLabel = { hourly: '시급제', daily: '일급제', monthly: '월급제', annual: '연봉제' };

export function payrollStatementHtml({ rows = [], details = [], month, employeeId = null, savedDraft = false }) {
  const targets = employeeId === null ? rows : rows.filter(row => row.staffId === employeeId);
  if (!targets.length) return '';
  const pages = targets.map((row, index) => {
    const attendance = details.filter(item => item.staffId === row.staffId).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const daily = attendance.length ? attendance.map(item => `<tr><td>${esc(item.date)}</td><td>${esc(item.shiftName)}<small>${esc(item.scheduledTime)}</small></td><td>${esc(item.actualTime)}</td><td>${minutes(item.grossMinutes)}</td><td>${minutes(item.breakMinutes)}</td><td>${minutes(item.payableMinutes)}</td><td>${item.dailyPay === null ? '—' : won(item.dailyPay)}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">퇴근 완료된 근태 기록이 없습니다.</td></tr>';
    const fixedSalary = row.payType === 'monthly' || row.payType === 'annual';
    const scheduledNote = fixedSalary ? '계약 월액 · 시간 비례 환산 없음' : `${Number(row.scheduledDays) || 0}일 · 휴게 차감 후 ${minutes(row.scheduledMinutes)}`;
    const actualNote = fixedSalary ? '계약 월액 · 근태는 아래에서 별도 확인' : `${Number(row.completedDays) || 0}일 · 급여 계산시간 ${minutes(row.workedMinutes)}`;
    return `<section class="page"><header><div><small>TIMEFIT · PAYROLL DRAFT</small><h1>${esc(month)} 급여명세 초안</h1><p>세금·공제 확정 전 검토 자료 · ${savedDraft ? '저장된 초안 금액' : '현재 예상 금액'}</p></div><div class="person"><small>직원</small><strong>${esc(row.name)}</strong><span>${esc(payLabel[row.payType] || row.payType || '—')}</span></div></header><div class="summary"><article>스케줄 기준 예상 급여<strong>${won(row.scheduledPay)}</strong><small>${scheduledNote}</small></article><article>실제 근무 기준 급여<strong>${won(row.basePay)}</strong><small>${actualNote}</small></article><article>급여 초안<strong>${won(row.estimatedTotal)}</strong><small>세금·공제 전 · ${savedDraft ? '저장 시점 금액' : '현재 예상 금액'}</small></article><article>적용 단가<strong>${won(row.rate)}</strong><small>${esc(payLabel[row.payType] || '')}</small></article></div><p class="note">${row.hasContract ? '계약 이력 적용' : '계약 이력 확인 필요'} · 승인 휴가 ${Number(row.leaveDays) || 0}일${savedDraft ? ' · 저장 이후 근태·계약 변경은 초안 재저장 후 반영' : ''}</p><h2>날짜별 근태·급여 산정 참고</h2><table><thead><tr><th>근무일</th><th>스케줄</th><th>실제 출퇴근</th><th>산정 체류</th><th>차감 휴게</th><th>급여시간</th><th>일별 시급</th></tr></thead><tbody>${daily}</tbody></table><footer><span>스케줄 기준은 해당 월 등록 근무 전체, 실제 기준은 퇴근 완료 기록만 반영합니다. 시급 외 일별 금액은 산정하지 않습니다.</span><span>${index + 1} / ${targets.length}</span></footer></section>`;
  }).join('');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>급여명세_초안_${esc(month)}</title><style>@page{size:A4 landscape;margin:12mm}*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}body{margin:0;background:#f2f4f6;color:#191f28;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}.page{width:273mm;min-height:182mm;margin:16px auto;padding:12mm;background:white;border-radius:14px;box-shadow:0 8px 28px #1e293b20;break-after:page}.page:last-of-type{break-after:auto}header{display:flex;justify-content:space-between;border-bottom:2px solid #3182f6;padding-bottom:14px}h1{margin:5px 0;font-size:24px}header small,header p,.note,footer{color:#6b7684;font-size:10px}header p{margin:0}.person{min-width:145px;padding:10px;border:1px solid #dfe5ec;border-radius:10px}.person>*{display:block}.person strong{margin:5px 0;font-size:17px}.person span{font-size:10px}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:18px 0}.summary article{padding:14px;background:#f5f8fc;border-radius:9px;font-size:10px;color:#6b7684}.summary strong,.summary small{display:block;margin-top:8px}.summary strong{font-size:17px;color:#191f28}.summary small{font-size:8px;line-height:1.4}.note{padding:10px;background:#f8f9fb;border-radius:8px}h2{font-size:14px;margin:20px 0 10px}table{width:100%;border-collapse:collapse;font-size:9px}th,td{padding:8px 6px;border-bottom:1px solid #e5e8eb;text-align:left}th{background:#e9eef5;color:#4e5968}td small{display:block;margin-top:4px;color:#8b95a1}.empty{text-align:center;padding:18px}footer{display:flex;justify-content:space-between;margin-top:18px}.print{position:fixed;right:20px;bottom:20px;padding:13px 18px;border:0;border-radius:10px;background:#3182f6;color:#fff;font-weight:700;cursor:pointer}@media print{body{background:#fff}.page{width:auto;min-height:0;margin:0;padding:0;border-radius:0;box-shadow:none}.print{display:none}}</style></head><body>${pages}<button class="print" onclick="window.print()">PDF 저장 · 인쇄</button></body></html>`;
}

export function openPayrollPrintView(input) {
  const html = payrollStatementHtml(input);
  if (!html) return false;
  const popup = window.open('', '_blank');
  if (!popup) return false;
  popup.opener = null;
  popup.document.write(html);
  popup.document.close();
  return true;
}
