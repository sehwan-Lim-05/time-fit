import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { axBaseUrl, axTimeout, normalizeImageUrls, normalizedRequestId } from '../server/api/receipt-ax.js';

function responseRecorder() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function configure() {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  process.env.TIMEFIT_AX_URL = 'https://ax.example.com';
  process.env.TIMEFIT_AX_ALLOWED_HOSTS = 'ax.example.com';
  process.env.TIMEFIT_AX_TRANSPORT_KEY = 'a'.repeat(32);
  process.env.TIMEFIT_AX_REQUEST_TIMEOUT_MS = '5000';
  process.env.NODE_ENV = 'production';
}

test('운영 AX 주소는 HTTPS와 명시적 허용 호스트를 요구한다', () => {
  assert.equal(axBaseUrl({ value: 'https://ax.example.com/', nodeEnv: 'production', allowedHosts: 'ax.example.com' }), 'https://ax.example.com');
  assert.throws(() => axBaseUrl({ value: 'http://ax.example.com', nodeEnv: 'production', allowedHosts: 'ax.example.com' }), /https_required/);
  assert.throws(() => axBaseUrl({ value: 'http://127.0.0.1:8351', nodeEnv: 'production', allowedHosts: '127.0.0.1' }), /loopback_development_only/);
  assert.throws(() => axBaseUrl({ value: 'https://ax.example.com', nodeEnv: 'production', allowedHosts: 'other.example.com' }), /host_not_allowed/);
});

test('영수증 이미지 URL은 HTTPS 공개 주소만 허용한다', () => {
  assert.deepEqual(normalizeImageUrls({ imageUrl: 'https://storage.example.com/receipt.jpg' }, { nodeEnv: 'production' }), ['https://storage.example.com/receipt.jpg']);
  assert.throws(() => normalizeImageUrls({ imageUrl: 'http://169.254.169.254/latest/meta-data' }, { nodeEnv: 'production' }), /unsafe/);
  assert.throws(() => normalizeImageUrls({ imageUrl: 'file:///etc/passwd' }, { nodeEnv: 'production' }), /unsafe/);
  assert.throws(() => normalizeImageUrls({ imageUrls: Array.from({ length: 21 }, (_, index) => `https://storage.example.com/${index}`) }), /urls_invalid/);
});

test('AX 요청 식별자와 타임아웃은 제한 범위를 적용한다', () => {
  assert.equal(normalizedRequestId('receipt:doc-1:retry_2', 'doc-1'), 'receipt:doc-1:retry_2');
  assert.throws(() => normalizedRequestId('contains space', 'doc-1'), /request_id_invalid/);
  assert.equal(axTimeout('55000'), 55000);
  assert.throws(() => axTimeout('240000'), /timeout_invalid/);
});

test('인증된 제출자의 AX 성공 결과를 저장하고 감사 로그를 남긴다', async t => {
  configure();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const value = String(url); calls.push({ value, options });
    if (value.includes('/auth/v1/user')) return jsonResponse({ id: 'user-1' });
    if (value.includes('/timefit_user_memberships')) return jsonResponse([{ organization_id: 'org-1', role: 'employee' }]);
    if (value.includes('/timefit_user_finance_documents?') && (!options.method || options.method === 'GET')) {
      return jsonResponse([{ id: 'doc-1', organization_id: 'org-1', uploaded_by: 'user-1', extracted_data: null, storage_path: 'org-1/doc-1.jpg', mime_type: 'image/jpeg', processing_status: 'uploaded', review_status: 'submitted' }]);
    }
    if (value.includes('/timefit_user_finance_document_pages?')) return jsonResponse([]);
    if (value.includes('/storage/v1/object/sign/timefit-finance-documents/')) return jsonResponse({ signedURL: '/object/sign/timefit-finance-documents/org-1/doc-1.jpg?token=test' });
    if (value === 'https://ax.example.com/api/timefit/v1/receipt-sessions') {
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['X-Timefit-Ax-Key'], 'a'.repeat(32));
      return jsonResponse({ state: 'SUCCEEDED', extraction: { merchantName: '상점', transactionDate: '2026-10-08', totalAmount: 12000, rawText: '영수증' }, imageContentSha256: 'abc' });
    }
    if (value.includes('/timefit_user_finance_documents?') && options.method === 'PATCH') return jsonResponse(null);
    if (value.endsWith('/rest/v1/timefit_user_expense_audit_logs')) return jsonResponse(null, 201);
    throw new Error(`unexpected_fetch:${value}`);
  });
  const res = responseRecorder();
  await handler({ method: 'POST', headers: { authorization: 'Bearer user-token' }, body: {
    organizationId: 'org-1', documentId: 'doc-1', imageUrl: 'https://storage.example.com/receipt.jpg', requestId: 'receipt:doc-1:test',
  } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.extraction.extractionProvider, 'timefit_ax_codex');
  const patches = calls.filter(call => call.value.includes('/timefit_user_finance_documents?') && call.options.method === 'PATCH').map(call => JSON.parse(call.options.body));
  assert.equal(patches[0].processing_status, 'processing');
  assert.equal(patches.at(-1).processing_status, 'ready');
  assert.ok(calls.some(call => call.value.endsWith('/rest/v1/timefit_user_expense_audit_logs')));
});

test('AX 실패 시 영수증을 실패 상태로 기록한다', async t => {
  configure();
  const patches = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const value = String(url);
    if (value.includes('/auth/v1/user')) return jsonResponse({ id: 'user-1' });
    if (value.includes('/timefit_user_memberships')) return jsonResponse([{ organization_id: 'org-1', role: 'employee' }]);
    if (value.includes('/timefit_user_finance_documents?') && (!options.method || options.method === 'GET')) {
      return jsonResponse([{ id: 'doc-1', organization_id: 'org-1', uploaded_by: 'user-1', extracted_data: null, storage_path: 'org-1/doc-1.jpg', mime_type: 'image/jpeg', review_status: 'submitted' }]);
    }
    if (value.includes('/timefit_user_finance_document_pages?')) return jsonResponse([]);
    if (value.includes('/storage/v1/object/sign/timefit-finance-documents/')) return jsonResponse({ signedURL: '/object/sign/timefit-finance-documents/org-1/doc-1.jpg?token=test' });
    if (value.includes('/timefit_user_finance_documents?') && options.method === 'PATCH') { patches.push(JSON.parse(options.body)); return jsonResponse(null); }
    if (value === 'https://ax.example.com/api/timefit/v1/receipt-sessions') return jsonResponse({ state: 'FAILED', errorCode: 'analysis_failed' }, 502);
    throw new Error(`unexpected_fetch:${value}`);
  });
  const res = responseRecorder();
  await handler({ method: 'POST', headers: { authorization: 'Bearer user-token' }, body: {
    organizationId: 'org-1', documentId: 'doc-1', imageUrl: 'https://storage.example.com/receipt.jpg',
  } }, res);
  assert.equal(res.statusCode, 502);
  assert.equal(patches.at(-1).processing_status, 'failed');
  assert.equal(patches.at(-1).processing_error, 'analysis_failed');
});

test('승인 또는 종료된 영수증은 재분석하지 않는다', async t => {
  configure();
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const value = String(url);
    if (value.includes('/auth/v1/user')) return jsonResponse({ id: 'user-1' });
    if (value.includes('/timefit_user_memberships')) return jsonResponse([{ organization_id: 'org-1', role: 'employee' }]);
    if (value.includes('/timefit_user_finance_documents?') && (!options.method || options.method === 'GET')) {
      return jsonResponse([{ id: 'doc-1', organization_id: 'org-1', uploaded_by: 'user-1', extracted_data: {}, review_status: 'approved' }]);
    }
    throw new Error(`unexpected_fetch:${value}`);
  });
  const res = responseRecorder();
  await handler({ method: 'POST', headers: { authorization: 'Bearer user-token' }, body: {
    organizationId: 'org-1', documentId: 'doc-1', imageUrl: 'https://storage.example.com/receipt.jpg',
  } }, res);
  assert.equal(res.statusCode, 409);
});
