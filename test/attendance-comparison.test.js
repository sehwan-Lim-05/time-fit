import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAttendanceComparisonRows } from '../src/attendanceComparison.js';

test('직원 상세 비교는 근무표의 무급 휴게를 실제 체류에서 차감한다', () => {
  const profile = { id: 'staff-1', name: '직원', attendanceHistory: [{ staff_id: 'staff-1', work_date: '2026-09-16', checked_in_at: 'in', checked_out_at: 'out' }] };
  const schedules = { '2026-09-16': [['직원', '09:30 – 21:30', '풀타임', 'schedule-1', 'staff-1', '운영팀', '#2563EB', 120, 'approved', 1, false]] };
  const rows = buildAttendanceComparisonRows(profile, schedules, {}, (_, matchingSchedules) => {
    assert.deepEqual(matchingSchedules[0], { staff_id: 'staff-1', work_date: '2026-09-16', starts_at: '09:30', ends_at: '21:30', break_minutes: 120, break_paid: false, shift_name: '풀타임' });
    return { grossMinutes: 720, breakMinutes: 120, payableMinutes: 600, scheduledMinutes: 720, overtimeMinutes: 0 };
  });
  assert.equal(rows[0].netMinutes, 600);
  assert.equal(rows[0].deductedBreakMinutes, 120);
  assert.equal(rows[0].completed, true);
});

test('근태 기록이 없는 예정 근무도 비교표에 남는다', () => {
  const rows = buildAttendanceComparisonRows({ id: 'staff-1', name: '직원', attendanceHistory: [] }, {
    '2026-09-17': [['직원', '09:30 – 21:30', '풀타임', 'schedule-2', 'staff-1', '운영팀', '#2563EB', 120, 'approved', 1, true]],
  }, {}, (_, matchingSchedules) => {
    assert.equal(matchingSchedules[0].break_paid, true);
    return { grossMinutes: 0, breakMinutes: 0, payableMinutes: 0, scheduledMinutes: 0, overtimeMinutes: 0 };
  });
  assert.equal(rows[0].schedule, '09:30 – 21:30');
  assert.equal(rows[0].completed, false);
});
