import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../supabase/migrations/20261005000300_att01_shared_qr_attendance.sql', import.meta.url), 'utf8');
const edge = readFileSync(new URL('../supabase/functions/qr-attendance/index.ts', import.meta.url), 'utf8');

test('ATT-01 keeps mobile attendance in the shared web attendance table', () => {
  assert.match(sql, /insert into public\.timefit_user_attendance_records/);
  assert.doesNotMatch(sql, /create table[^;]+mobile_attendance_records/i);
  assert.match(sql, /'mobile_qr',p_request_key/);
});

test('ATT-01 scopes QR sessions to the organization workplace and authenticated staff', () => {
  assert.match(sql, /timefit_user_attendance_qr_sessions/);
  assert.match(sql, /organization_id=v_qr\.organization_id and user_id=auth\.uid\(\)/);
  assert.match(sql, /workplace_access_denied/);
  assert.match(sql, /expires_at>v_now/);
  assert.match(sql, /session\.revoked_at is null/);
});

test('ATT-01 serializes employee scans and links overnight checkout', () => {
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /checked_out_at is null/);
  assert.match(sql, /interval '18 hours'/);
  assert.match(sql, /interval '60 seconds'/);
  assert.doesNotMatch(sql, /on conflict\(staff_id,work_date\) do update set checked_in_at/i);
});

test('an ambiguous write can be confirmed after its photographed QR expires', () => {
  const duplicateLookup = sql.indexOf('check_in_request_key=p_request_key');
  const activeTokenCheck = sql.indexOf('A retry with the same request key');
  assert.ok(duplicateLookup > 0 && activeTokenCheck > duplicateLookup);
});

test('QR edge function no longer accepts a client-selected attendance action', () => {
  assert.match(edge, /requestKey/);
  assert.doesNotMatch(edge, /p_action/);
  assert.match(edge, /timefit_user_mobile_qr_attendance/);
});
