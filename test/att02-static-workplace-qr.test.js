import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../supabase/migrations/20261006000400_att02_static_workplace_qr.sql', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');

test('ATT-02 persists one workplace QR until a manager regenerates it', () => {
  assert.match(migration, /timefit_user_attendance_static_qr/);
  assert.match(migration, /p_regenerate boolean default false/);
  assert.match(migration, /'infinity'::timestamptz/);
  assert.match(migration, /timefit_user_has_membership_role/);
});

test('manager web offers print, PNG download, and explicit revocation', () => {
  assert.match(main, /인쇄하기/);
  assert.match(main, /PNG 저장/);
  assert.match(main, /기존 QR 폐기·재발급/);
  assert.doesNotMatch(main, /60초마다 자동 갱신/);
});
