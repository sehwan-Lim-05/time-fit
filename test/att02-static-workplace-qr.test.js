import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../supabase/migrations/20261006000400_att02_static_workplace_qr.sql', import.meta.url), 'utf8');
const immutableMigration = readFileSync(new URL('../supabase/migrations/20261007000100_att02_immutable_workplace_qr.sql', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const supabase = readFileSync(new URL('../src/lib/supabase.js', import.meta.url), 'utf8');

test('ATT-02 persists exactly one immutable workplace QR', () => {
  assert.match(migration, /timefit_user_attendance_static_qr/);
  assert.match(migration, /p_regenerate boolean default false/);
  assert.match(migration, /'infinity'::timestamptz/);
  assert.match(migration, /timefit_user_has_membership_role/);
  assert.match(immutableMigration, /existing QR is always returned unchanged/i);
  assert.match(immutableMigration, /if v_static\.organization_id is not null then/);
  assert.doesNotMatch(immutableMigration, /delete from public\.timefit_user_attendance_static_qr/);
  assert.match(supabase, /p_regenerate: false/);
});

test('owner web displays the QR and offers print and PNG download without regeneration', () => {
  assert.match(main, /인쇄하기/);
  assert.match(main, /PNG 저장/);
  assert.match(main, /영구 고정 QR/);
  assert.match(main, /organizationId=\{authContext\.membership\?\.organization_id\}/);
  assert.match(main, /organizationName=\{authContext\.membership\?\.timefit_user_organizations\?\.name\}/);
  assert.match(main, /canManageQr=\{Boolean\(authContext\.isOrganizationOwner\)\}/);
  assert.doesNotMatch(main, /기존 QR 폐기·재발급/);
  assert.doesNotMatch(main, /getStaticAttendanceQr\(organizationId,true\)/);
  assert.doesNotMatch(main, /60초마다 자동 갱신/);
});
