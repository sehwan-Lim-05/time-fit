import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('영수증 원본은 인증된 Google Drive 함수로 업로드된다', async () => {
  const source = await read('supabase/functions/upload-receipt-drive/index.ts');
  assert.match(source, /admin\.auth\.getUser/);
  assert.match(source, /timefit_user_memberships/);
  assert.match(source, /www\.googleapis\.com\/upload\/drive\/v3\/files/);
  assert.match(source, /webViewLink/);
  assert.match(source, /GOOGLE_DRIVE_FOLDER_ID/);
  assert.match(source, /GOOGLE_DRIVE_REFRESH_TOKEN/);
  assert.match(source, /supportsAllDrives=true/);
});

test('관리자와 직원 영수증 UI는 OCR·검토 저장을 호출하지 않는다', async () => {
  const [main, employee] = await Promise.all([read('src/main.jsx'), read('src/features/finance/EmployeeReceiptSubmission.jsx')]);
  const manager = main.slice(main.indexOf('function ManagerReceiptUpload'), main.indexOf('function ExpenseWorkspace'));
  assert.match(manager, /uploadReceiptToGoogleDrive/);
  assert.doesNotMatch(manager, /createReceiptSubmission|processReceiptDocument/);
  assert.match(employee, /uploadReceiptToGoogleDrive/);
  assert.doesNotMatch(employee, /createReceiptSubmission|processReceiptDocument|confirmReceiptSubmission|loadMyReceiptDocuments/);
  assert.doesNotMatch(main, /\['evidence', '증빙 검토'\]/);
});

test('Drive 업로드 링크는 페이지 이동과 새로고침 후에도 복원된다', async () => {
  const [client, main, employee] = await Promise.all([read('src/lib/supabase.js'), read('src/main.jsx'), read('src/features/finance/EmployeeReceiptSubmission.jsx')]);
  assert.match(client, /timefit:drive-receipts:/);
  assert.match(client, /localStorage\.setItem/);
  assert.match(client, /export async function loadDriveReceiptUploads/);
  assert.match(main, /loadDriveReceiptUploads\(organizationId\)/);
  assert.match(employee, /loadDriveReceiptUploads\(organizationId\)/);
  assert.match(employee, /const form = event\.currentTarget/);
});
