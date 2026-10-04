import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePayrollDraftLine } from '../src/payrollDraftLine.js';

test('초 단위 근태에서 나온 소수 분과 급여를 DB 타입에 맞춰 저장한다', () => {
  const line = normalizePayrollDraftLine({
    staff_id: 'a', applied_rate: 12000, scheduled_minutes: 360,
    worked_minutes: 3446.5279333333337, completed_work_days: 10,
    approved_leave_days: 0.5, base_pay: 689305.5866666667,
    estimated_total: 689305.5866666667,
  });
  assert.equal(line.worked_minutes, 3447);
  assert.equal(line.base_pay, 689306);
  assert.equal(line.estimated_total, 689306);
  assert.equal(line.approved_leave_days, 0.5);
  assert.equal(line.staff_id, 'a');
});

test('유효하지 않은 급여는 DB 기록을 삭제하기 전에 거부한다', () => {
  assert.throws(() => normalizePayrollDraftLine({ worked_minutes: Number.NaN }), /근무시간/);
});
