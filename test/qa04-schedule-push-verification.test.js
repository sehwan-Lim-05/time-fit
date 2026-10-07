import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const foundation = readFileSync(new URL('../supabase/migrations/20261006000100_alt01_notification_foundation.sql', import.meta.url), 'utf8');
const dispatcher = readFileSync(new URL('../supabase/functions/dispatch-schedule-push/index.ts', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/dispatch-schedule-push.yml', import.meta.url), 'utf8');
const client = readFileSync(new URL('../src/lib/supabase.js', import.meta.url), 'utf8');

test('QA-04 publishes only approved new or materially changed schedules', () => {
  assert.match(foundation, /new\.approval_status<>'approved'/);
  assert.match(foundation, /old\.approval_status='approved'/);
  assert.match(foundation, /is not distinct from/);
  assert.match(foundation, /schedule_approved/);
  assert.match(foundation, /schedule_changed/);
  assert.match(foundation, /on conflict\(dedupe_key\) do nothing/);
});

test('QA-04 scheduled workflow targets the deployed push dispatcher contract', () => {
  assert.match(workflow, /functions\/v1\/dispatch-schedule-push/);
  assert.match(workflow, /x-timefit-dispatch-secret/);
  assert.match(dispatcher, /SCHEDULE_PUSH_DISPATCH_SECRET/);
  assert.match(dispatcher, /timefit_user_claim_push_deliveries/);
});

test('QA-04 delivery supports safe deep links, retry, and stale subscription revocation', () => {
  assert.match(dispatcher, /notifications\|schedule\|attendance\|requests\|approvals/);
  assert.match(dispatcher, /retry_wait/);
  assert.match(dispatcher, /attempt_count \|\| 1\) >= 5/);
  assert.match(dispatcher, /status === 404 \|\| status === 410/);
  assert.match(dispatcher, /revoked_reason/);
});

test('QA-04 schedule save does not depend on a drifted unique constraint', () => {
  const saveSection = client.slice(client.indexOf('export async function saveWorkSchedule'), client.indexOf('export async function deleteWorkSchedule'));
  assert.doesNotMatch(saveSection, /onConflict: 'staff_id,work_date'/);
  assert.match(saveSection, /\.maybeSingle\(\)/);
  assert.match(saveSection, /existing\?\.id/);
});
