import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const api = readFileSync(new URL('../src/lib/supabase.js', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');

test('근무 일정 등록은 제거된 직원+날짜 고유 제약을 ON CONFLICT 대상으로 사용하지 않는다', () => {
  assert.doesNotMatch(api, /timefit_user_work_schedules'[\s\S]{0,500}onConflict:\s*'staff_id,work_date'/);
  assert.match(api, /from\('timefit_user_work_schedules'\)\.insert\(rows\)\.select\(\)/);
});

test('근무 일정 수정은 다중 근무 환경에서도 정확한 일정 ID만 변경한다', () => {
  assert.match(api, /saveWorkSchedule\(\{ scheduleId = null,/);
  assert.match(api, /\.update\(payload\)\.eq\('id', scheduleId\)/);
  assert.match(main, /saveWorkSchedule\(\{ scheduleId: schedule\.id,/);
  assert.match(main, /scheduleIdsByDate: Object\.fromEntries/);
  assert.match(main, /const scheduleId = change\.scheduleIdsByDate\?\.\[workDate\]/);
});

test('근무 시간 충돌은 사용자가 이해할 수 있는 안내로 변환한다', () => {
  assert.match(api, /error\.code === '23P01'/);
  assert.match(api, /throw new Error\('schedule_time_conflict'\)/);
  assert.match(main, /이미 등록된 근무 시간과 겹쳐요/);
});
