const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

const minutesLabel = value => {
  const minutes = Math.max(0, Math.round(Number(value) || 0));
  return `${Math.floor(minutes / 60)}시간 ${String(minutes % 60).padStart(2, '0')}분`;
};

const timeLabel = value => value ? new Intl.DateTimeFormat('ko-KR', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul',
}).format(new Date(value)) : '-';

export function openAttendanceComparisonPrintView({ employee, month, rows, summary }) {
  if (!employee || !rows?.length) return false;
  const ordered = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const pages = [];
  for (let index = 0; index < ordered.length; index += 10) pages.push(ordered.slice(index, index + 10));
  const content = pages.map((page, pageIndex) => {
    const body = page.map(row => {
      const status = row.completed ? '퇴근 완료' : row.checkedInAt ? '근무 중' : row.date > new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()) ? '예정' : '기록 없음';
      const breakLabel = row.registeredBreakMinutes
        ? `${minutesLabel(row.registeredBreakMinutes)} (${row.breakPaid ? '급여 포함' : '급여 미포함'})`
        : '등록 없음';
      return `<tr><td><b>${escapeHtml(row.date)}</b><small>${escapeHtml(status)}</small></td><td><b>${escapeHtml(row.shiftName || row.schedule)}</b><small>${escapeHtml(row.schedule)}</small></td><td>${escapeHtml(timeLabel(row.checkedInAt))} - ${escapeHtml(timeLabel(row.checkedOutAt))}</td><td>${row.completed ? minutesLabel(row.grossMinutes) : '-'}</td><td><b>${escapeHtml(breakLabel)}</b><small>차감 ${row.completed ? minutesLabel(row.deductedBreakMinutes) : '-'}</small></td><td class="net">${row.completed ? minutesLabel(row.netMinutes) : '-'}</td><td>${row.completed && row.payableMinutes !== row.netMinutes ? minutesLabel(row.payableMinutes) : row.completed ? '실근무와 동일' : '-'}</td></tr>`;
    }).join('');
    return `<section class="page"><header><div><span>TIMEFIT ATTENDANCE REPORT</span><h1>${escapeHtml(month.replace('-', '년 '))}월 근무시간 비교표</h1><p>근무표와 실제 출퇴근 기록을 대조한 개인별 자료</p></div><aside><small>직원 / 소속</small><b>${escapeHtml(employee.name)}</b><em>${escapeHtml(employee.team || '미분류')}</em></aside></header><div class="summary"><article><small>실제 체류시간</small><b>${minutesLabel(summary.grossMinutes)}</b></article><article><small>급여 미포함 휴게 차감</small><b>-${minutesLabel(summary.deductedBreakMinutes)}</b></article><article class="primary"><small>실근무시간</small><b>${minutesLabel(summary.netMinutes)}</b></article><article><small>급여 반영시간</small><b>${minutesLabel(summary.payableMinutes)}</b></article></div><table><thead><tr><th>날짜 / 상태</th><th>예정 근무표</th><th>실제 출퇴근</th><th>체류</th><th>휴게 등록 / 차감</th><th>실근무</th><th>급여 반영</th></tr></thead><tbody>${body}</tbody></table><footer><span>실근무 = 체류 - 급여 미포함 휴게 · 급여 반영은 운영 설정의 반올림 기준 적용</span><b>${pageIndex + 1} / ${pages.length}</b></footer></section>`;
  }).join('');
  const popup = window.open('', '_blank');
  if (!popup) return false;
  popup.opener = null;
  popup.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>근무시간_${escapeHtml(employee.name)}_${escapeHtml(month)}</title><style>@page{size:A4 landscape;margin:9mm}*{box-sizing:border-box;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}body{margin:0;background:#edf2f7;color:#191f28;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}.page{width:277mm;min-height:190mm;margin:16px auto;padding:11mm;border-top:6px solid #2563eb;border-radius:12px;background:#fff;box-shadow:0 8px 28px #1e293b18;page-break-after:always}.page:last-of-type{page-break-after:auto}header{display:flex;justify-content:space-between;gap:20px;padding-bottom:7mm;border-bottom:1px solid #dfe5ec}header span{color:#2563eb;font-size:9px;font-weight:900;letter-spacing:1.3px}h1{margin:4px 0;font-size:23px}header p{margin:0;color:#6b7684;font-size:10px}aside{min-width:48mm;padding:10px 13px;border:1px solid #dfe5ec;border-left:5px solid #2563eb;border-radius:9px}aside small,aside b,aside em{display:block}aside b{margin:4px 0;font-size:17px}aside em{color:#6b7684;font-size:10px;font-style:normal}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:7mm 0 6mm}.summary article{padding:11px;border:1px solid #e5e8eb;border-radius:9px;background:#f8fafc}.summary .primary{background:#edf5ff;border-color:#bfdbfe}.summary small{display:block;color:#6b7684;font-size:8px}.summary b{display:block;margin-top:5px;font-size:15px}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:8.5px}th{padding:8px 6px;background:#e9eef5;color:#4e5968;text-align:left}th:nth-child(1){width:12%}th:nth-child(2){width:18%}th:nth-child(3){width:17%}th:nth-child(4){width:10%}th:nth-child(5){width:19%}th:nth-child(6){width:11%}th:nth-child(7){width:13%}td{padding:8px 6px;border-bottom:1px solid #edf0f3;vertical-align:top}td b,td small{display:block}td small{margin-top:3px;color:#6b7684;font-size:7px}.net{color:#1769d2;font-weight:900}footer{display:flex;justify-content:space-between;gap:15px;margin-top:5mm;padding-top:3mm;border-top:1px solid #dfe5ec;color:#6b7684;font-size:8px}.print{position:fixed;right:22px;bottom:22px;padding:13px 18px;border:0;border-radius:10px;background:#3182f6;color:#fff;font-weight:800;cursor:pointer}@media print{body{background:#fff}.page{width:auto;min-height:0;margin:0;padding:0;border-radius:0;box-shadow:none}.print{display:none}}</style></head><body>${content}<button class="print" onclick="window.print()">PDF 저장 · 인쇄</button></body></html>`);
  popup.document.close();
  return true;
}
