import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../supabase/migrations/20261006000200_alt02_attendance_missing_alerts.sql', import.meta.url), 'utf8');

test('ALT-02 scans only published and approved work schedules', () => {
  assert.match(sql, /schedule\.status='published' and schedule\.approval_status='approved'/);
  assert.match(sql, /not schedule\.is_day_off/);
});

test('ALT-02 supports separate check-in and check-out grace windows', () => {
  assert.match(sql, /absence_alert_delay_minutes/);
  assert.match(sql, /checkout_alert_delay_minutes/);
  assert.match(sql, /checkout_after_scheduled_end/);
});

test('ALT-02 links overnight checkout to the schedule start date', () => {
  assert.match(sql, /v_effective_end<=v_effective_start then 1 else 0 end/);
  assert.match(sql, /attendance\.work_date=schedule\.work_date/);
});

test('ALT-02 handles full and half-day leave separately', () => {
  assert.match(sql, /approved_full_day_leave/);
  assert.match(sql, /v_leave\.day_part='am'/);
  assert.match(sql, /v_leave\.day_part='pm'/);
});

test('ALT-02 targets owners and active attendance managers with scope checks', () => {
  assert.match(sql, /organization\.owner_id/);
  assert.match(sql, /permission\.permission_code='attendance\.view'/);
  assert.match(sql, /timefit_user_management_scopes/);
});

test('ALT-02 uses one semantic notification key per schedule incident', () => {
  assert.match(sql, /'attendance:'\|\|v_alert\.schedule_id::text/);
  assert.match(sql, /on conflict\(recipient_user_id,dedupe_key\) do nothing/);
  assert.match(sql, /resolution_reason='check_out_recorded'/);
});
