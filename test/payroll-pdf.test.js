import test from 'node:test';
import assert from 'node:assert/strict';
import { payrollStatementHtml } from '../src/payrollPdf.js';

const rows = [
  { staffId: 'staff-1', name: '김민지', payType: 'hourly', rate: 12000, scheduledMinutes: 540, scheduledDays: 1, scheduledPay: 108000, workedMinutes: 480, basePay: 96000, completedDays: 1, leaveDays: 0, estimatedTotal: 96000, hasContract: true },
  { staffId: 'staff-2', name: '이준호', payType: 'monthly', rate: 2500000, scheduledMinutes: 0, scheduledDays: 0, scheduledPay: 2500000, workedMinutes: 0, basePay: 2500000, completedDays: 0, leaveDays: 0, estimatedTotal: 2500000, hasContract: false },
];
const details = [{ staffId: 'staff-1', date: '2026-09-05', shiftName: '<마감>', scheduledTime: '09:00~18:00', actualTime: '09:00~18:00', grossMinutes: 540, breakMinutes: 60, payableMinutes: 480, dailyPay: 96000 }];

test('monthly PDF print view contains all employees and attendance breakdown', () => {
  const html = payrollStatementHtml({ rows, details, month: '2026-09', savedDraft: true });
  assert.match(html, /김민지/);
  assert.match(html, /이준호/);
  assert.match(html, /2026-09-05/);
  assert.match(html, /96,000원/);
  assert.match(html, /스케줄 기준 예상 급여<strong>108,000원/);
  assert.match(html, /실제 근무 기준 급여<strong>96,000원/);
  assert.match(html, /PDF 저장 · 인쇄/);
  assert.match(html, /저장 이후 근태·계약 변경/);
  assert.match(html, /&lt;마감&gt;/);
  assert.doesNotMatch(html, /<마감>/);
});

test('individual PDF includes only selected staff, and unknown staff has no output', () => {
  const html = payrollStatementHtml({ rows, details, month: '2026-09', employeeId: 'staff-2' });
  assert.match(html, /이준호/);
  assert.doesNotMatch(html, /김민지|2026-09-05/);
  assert.match(html, /퇴근 완료된 근태 기록이 없습니다/);
  assert.equal(payrollStatementHtml({ rows, details, month: '2026-09', employeeId: 'missing' }), '');
});
