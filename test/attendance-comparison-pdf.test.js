import test from 'node:test';
import assert from 'node:assert/strict';
import { openAttendanceComparisonPrintView } from '../src/attendanceComparisonPdf.js';

test('개인 근무시간 PDF는 스케줄, 휴게 차감, 실근무와 급여 반영시간을 표시한다', () => {
  let html = '';
  const previousWindow = globalThis.window;
  globalThis.window = { open: () => ({ document: { write: value => { html = value; }, close: () => {} } }) };
  try {
    const result = openAttendanceComparisonPrintView({
      employee: { name: '테스트 직원', team: '운영팀' }, month: '2026-09',
      rows: [{ date: '2026-09-16', schedule: '09:30 – 21:30', shiftName: '풀타임', checkedInAt: '2026-09-16T00:30:00Z', checkedOutAt: '2026-09-16T12:30:00Z', grossMinutes: 720, registeredBreakMinutes: 120, deductedBreakMinutes: 120, netMinutes: 600, payableMinutes: 600, completed: true }],
      summary: { grossMinutes: 720, deductedBreakMinutes: 120, netMinutes: 600, payableMinutes: 600 },
    });
    assert.equal(result, true);
    assert.match(html, /테스트 직원/);
    assert.match(html, /09:30 – 21:30/);
    assert.match(html, /12시간 00분/);
    assert.match(html, /차감 2시간 00분/);
    assert.match(html, /10시간 00분/);
    assert.match(html, /PDF 저장 · 인쇄/);
  } finally {
    globalThis.window = previousWindow;
  }
});
