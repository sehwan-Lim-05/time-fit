import test from 'node:test';
import assert from 'node:assert/strict';
import { payrollBreakMinutes } from '../src/payrollBreakPolicy.js';

const fullTime = { shift_name: '풀타임 근무', break_minutes: 0, is_day_off: false };

test('temporary Butter Villa policy deducts 120 minutes for full-time even when general deduction is off', () => {
  const policy = { temporary_fulltime_break_minutes: 120, payroll_deduct_break_enabled: false };
  assert.equal(payrollBreakMinutes({ schedule: fullTime, policy, grossMinutes: 720 }), 120);
  assert.equal(payrollBreakMinutes({ schedule: { ...fullTime, shift_name: '주말 풀타임', break_minutes: 30 }, policy, grossMinutes: 600 }), 120);
  assert.equal(payrollBreakMinutes({ schedule: fullTime, policy, grossMinutes: 90 }), 90);
});

test('temporary Butter Villa policy also deducts 120 minutes for regular shifts', () => {
  const policy = { temporary_fulltime_break_minutes: 120, payroll_deduct_break_enabled: false };
  assert.equal(payrollBreakMinutes({ schedule: { shift_name: '일반 근무', break_minutes: 30, is_day_off: false }, policy, grossMinutes: 600 }), 120);
  assert.equal(payrollBreakMinutes({ schedule: { shift_name: '일반근무', break_minutes: 0, is_day_off: false }, policy, grossMinutes: 480 }), 120);
});

test('other shifts and organizations retain existing deduction settings', () => {
  const policy = { temporary_fulltime_break_minutes: 120, payroll_deduct_break_enabled: false };
  assert.equal(payrollBreakMinutes({ schedule: { shift_name: '오전 근무', break_minutes: 30 }, policy, grossMinutes: 300 }), 0);
  assert.equal(payrollBreakMinutes({ schedule: fullTime, policy: { payroll_deduct_break_enabled: false }, grossMinutes: 720 }), 0);
  assert.equal(payrollBreakMinutes({ schedule: { shift_name: '오전 근무', break_minutes: 30 }, policy: { payroll_deduct_break_enabled: true }, grossMinutes: 300 }), 30);
});
