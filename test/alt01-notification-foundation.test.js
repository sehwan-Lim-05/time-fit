import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allowedPushPath, retryDelaySeconds } from '../server/api/push-notification-worker.js';

const sql = readFileSync(new URL('../supabase/migrations/20261005000300_alt01_notification_foundation.sql', import.meta.url), 'utf8');

test('in-app notification is durable before push fanout', () => {
  assert.match(sql, /timefit_user_notifications/);
  assert.match(sql, /after insert on public\.timefit_user_notifications/);
  assert.match(sql, /timefit_user_notification_deliveries/);
});

test('one endpoint can belong to only one current account', () => {
  assert.match(sql, /on public\.timefit_user_mobile_push_subscriptions\(endpoint\)/);
  assert.match(sql, /on conflict\(endpoint\) do update set user_id=auth\.uid\(\)/);
  assert.match(sql, /user_logout/);
});

test('schedule events use a semantic dedupe key', () => {
  assert.match(sql, /concat_ws\(':','schedule'/);
  assert.match(sql, /on conflict\(dedupe_key\) do nothing/);
});

test('push links remain inside approved mobile sections', () => {
  assert.equal(allowedPushPath('/#schedule'), '/#schedule');
  assert.equal(allowedPushPath('https://evil.example'), '/#notifications');
  assert.equal(allowedPushPath('/#admin'), '/#notifications');
});

test('retry delay grows and is capped', () => {
  assert.equal(retryDelaySeconds(1), 30);
  assert.equal(retryDelaySeconds(2), 60);
  assert.equal(retryDelaySeconds(99), 3600);
});
