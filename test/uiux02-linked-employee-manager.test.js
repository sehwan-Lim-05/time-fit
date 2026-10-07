import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const createAccount = readFileSync(new URL('../supabase/functions/create-management-account/index.ts', import.meta.url), 'utf8');
const manageAccount = readFileSync(new URL('../supabase/functions/manage-management-account/index.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20261007000400_link_existing_employee_management.sql', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const userContext = readFileSync(new URL('../supabase/functions/get-user-context/index.ts', import.meta.url), 'utf8');

test('UIUX-02 links management access to an existing employee identity', () => {
  assert.match(createAccount, /accountMode === 'link_existing'/);
  assert.match(createAccount, /staff\.user_id/);
  assert.match(createAccount, /account_origin: 'linked_employee'/);
  assert.match(createAccount, /force_password_change: false/);
});

test('UIUX-02 revokes linked management access without deleting employee auth', () => {
  const start = manageAccount.indexOf("account.account_origin === 'linked_employee'");
  const linkedDelete = manageAccount.slice(start, manageAccount.indexOf('const { error } = await admin.auth.admin.deleteUser', start));
  assert.match(linkedDelete, /timefit_user_management_accounts.*delete/);
  assert.doesNotMatch(linkedDelete, /auth\.admin\.deleteUser/);
  assert.match(linkedDelete, /employeeAccountPreserved: true/);
});

test('UIUX-02 records auditable scoped permission changes', () => {
  assert.match(migration, /timefit_user_management_audit_logs/);
  assert.match(migration, /linked_employee/);
  assert.match(createAccount, /action: 'linked'/);
  assert.match(manageAccount, /action: 'revoked'/);
});

test('UIUX-02 owner UI defaults to linking an existing employee', () => {
  assert.match(ui, /useState\('link_existing'\)/);
  assert.match(ui, /기존 직원에게 권한 부여/);
  assert.match(ui, /직원 로그인 정보는 변경되지 않습니다/);
  assert.match(ui, /직원 계정과 근무 데이터는 유지됩니다/);
});

test('UIUX-02 removes suspended management access from both web and app context', () => {
  assert.match(userContext, /eq\('status', 'active'\)/);
  assert.match(migration, /management\.status = 'active'/);
  assert.match(migration, /management_permissions/);
});
