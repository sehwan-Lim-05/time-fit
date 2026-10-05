import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../supabase/migrations/20261006000200_alt03_schedule_leave_notifications.sql', import.meta.url);
const sql = await readFile(migrationUrl, 'utf8');

test('ALT-03 records durable leave workflow events', () => {
  assert.match(sql, /timefit_user_leave_notification_outbox/);
  assert.match(sql, /leave_submitted/);
  assert.match(sql, /leave_approved/);
  assert.match(sql, /leave_rejected/);
  assert.match(sql, /unique\(recipient_user_id,dedupe_key\)/);
});

test('ALT-03 limits submission alerts to authorized scoped reviewers', () => {
  assert.match(sql, /permission_code='leave\.review'/);
  assert.match(sql, /account\.status='active'/);
  assert.match(sql, /scope\.category_id=v_staff\.category_id/);
  assert.match(sql, /organization\.owner_id/);
});

test('ALT-03 projects privacy-safe in-app notifications and deep links', () => {
  assert.match(sql, /\/#approvals\?kind=leave&id=/);
  assert.match(sql, /\/#requests\?id=/);
  assert.doesNotMatch(sql, /new\.reason/);
  assert.doesNotMatch(sql, /new\.review_comment/);
  assert.match(sql, /on conflict\(recipient_user_id,dedupe_key\) do nothing/);
});

test('ALT-01 remains the schedule notification source', async () => {
  const foundation = await readFile(new URL('../supabase/migrations/20261005000300_alt01_notification_foundation.sql', import.meta.url), 'utf8');
  assert.match(foundation, /schedule_approved/);
  assert.match(foundation, /schedule_changed/);
  assert.match(foundation, /\/#schedule/);
});
