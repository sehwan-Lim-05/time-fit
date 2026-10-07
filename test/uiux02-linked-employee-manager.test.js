import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const createAccount = readFileSync(new URL('../supabase/functions/create-management-account/index.ts', import.meta.url), 'utf8');
const manageAccount = readFileSync(new URL('../supabase/functions/manage-management-account/index.ts', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../supabase/migrations/20261007000400_link_existing_employee_management.sql', import.meta.url), 'utf8');
const compensationMigration = readFileSync(new URL('../supabase/migrations/20261007000500_split_employee_compensation_permissions.sql', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const userContext = readFileSync(new URL('../supabase/functions/get-user-context/index.ts', import.meta.url), 'utf8');
const access = readFileSync(new URL('../src/lib/managementAccess.js', import.meta.url), 'utf8');

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
  assert.match(ui, /useState\(["']link_existing["']\)/);
  assert.match(ui, /기존 직원에게 권한 부여/);
  assert.match(ui, /직원 로그인 정보는 변경되지 않습니다/);
  assert.match(ui, /직원 계정과 근무 데이터는 유지됩니다/);
});

test('UIUX-02 removes suspended management access from both web and app context', () => {
  assert.match(userContext, /eq\('status', 'active'\)/);
  assert.match(migration, /management\.status = 'active'/);
  assert.match(migration, /management_permissions/);
});

test('UIUX-02 keeps one canonical approval and attendance permission catalog', () => {
  for (const code of ['attendance.manage', 'attendance.review_correction', 'schedule.approve']) {
    assert.match(createAccount, new RegExp(code.replace('.', '\\.')));
    assert.match(manageAccount, new RegExp(code.replace('.', '\\.')));
    assert.match(migration, new RegExp(code.replace('.', '\\.')));
    assert.match(ui, new RegExp(code.replace('.', '\\.')));
  }
});

test('UIUX-02 expands mutating permissions with their required view permission', () => {
  for (const source of [createAccount, manageAccount]) {
    assert.match(source, /'attendance\.manage': \['attendance\.view'\]/);
    assert.match(source, /'schedule\.approve': \['schedule\.view'\]/);
    assert.match(source, /'leave\.review': \['leave\.view'\]/);
    assert.match(source, /'sales\.sync': \['sales\.view'\]/);
    assert.match(source, /'expense\.export': \['finance\.view'\]/);
  }
});

test('UIUX-02 enforces delegated schedule approval and attendance correction by staff scope', () => {
  assert.match(migration, /has_management_permission\(v_row\.organization_id,'schedule\.approve'\)/);
  assert.match(migration, /management_can_access_staff\(v_row\.organization_id,v_row\.staff_id\)/);
  assert.match(migration, /has_management_permission\(p_organization_id,'attendance\.review_correction'\)/);
  assert.match(migration, /management_can_access_staff\(p_organization_id,p_staff_id\)/);
});

test('UIUX-02 hides privileged web actions without their matching permission', () => {
  assert.match(ui, /canApproveSchedule/);
  assert.match(ui, /canCorrectAttendance/);
  assert.match(ui, /modal\?\.type === "scheduleEdit" && canManageSchedule/);
  assert.match(ui, /canManage=\{canManageSchedule\}/);
});

test('UIUX-02 offers least-privilege role presets and locks required view permissions', () => {
  assert.match(ui, /store_manager/);
  assert.match(ui, /part_lead/);
  assert.match(ui, /accountant/);
  assert.match(ui, /read_only/);
  assert.match(ui, /requiredPermissions\(createPermissions\)\.has\(value\)/);
  assert.match(ui, /상위 권한에 필수/);
  assert.match(ui, /permissions: createPermissions/);
});

test('UIUX-03 separates employee compensation from payroll aggregate access', () => {
  for (const source of [createAccount, manageAccount, migration, compensationMigration, ui]) {
    assert.match(source, /employee\.compensation\.view/);
    assert.match(source, /employee\.compensation\.manage/);
  }
  assert.match(createAccount, /'employee\.compensation\.manage': \['employee\.view', 'employee\.compensation\.view'\]/);
  assert.match(manageAccount, /'employee\.compensation\.manage': \['employee\.view', 'employee\.compensation\.view'\]/);
  assert.match(ui, /canViewCompensation/);
  assert.match(ui, /canManageCompensation/);
});

test('UIUX-03 refreshes delegated access when the web app becomes active again', () => {
  assert.match(ui, /refreshManagementContext/);
  assert.match(ui, /window\.addEventListener\("focus", refreshManagementContext\)/);
  assert.match(ui, /document\.addEventListener\("visibilitychange", refreshManagementContext\)/);
  assert.match(ui, /setMode\(accountRole === "manager" \? "manager" : "employee"\)/);
});

test('UIUX-03 revalidates critical writes and safely handles revoked access', () => {
  for (const permission of ['employee.manage', 'schedule.manage', 'schedule.approve', 'leave.review']) {
    assert.match(ui, new RegExp(`revalidateManagementPermission\\(\\s*["']${permission.replace('.', '\\.')}["']`));
  }
  assert.match(ui, /setMode\("employee"\)/);
  assert.match(ui, /setActive\("employeeHome"\)/);
  assert.match(access, /403\|permission\|denied\|forbidden\|row-level security\|42501/i);
});
