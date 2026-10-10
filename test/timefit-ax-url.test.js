import assert from 'node:assert/strict';
import test from 'node:test';

import { extractReceiptWithTimefitAx, normalizeTimefitAxExtraction, resolveTimefitAxUrl } from '../server/api/_timefit-ax.js';

function withAxUrl(value, callback) {
  const previous = process.env.TIMEFIT_AX_URL;
  const previousHosts = process.env.TIMEFIT_AX_ALLOWED_HOSTS;
  if (value === undefined) delete process.env.TIMEFIT_AX_URL;
  else {
    process.env.TIMEFIT_AX_URL = value;
    process.env.TIMEFIT_AX_ALLOWED_HOSTS = new URL(value).hostname;
  }
  try {
    callback();
  } finally {
    if (previous === undefined) delete process.env.TIMEFIT_AX_URL;
    else process.env.TIMEFIT_AX_URL = previous;
    if (previousHosts === undefined) delete process.env.TIMEFIT_AX_ALLOWED_HOSTS;
    else process.env.TIMEFIT_AX_ALLOWED_HOSTS = previousHosts;
  }
}

test('Timefit AX URL defaults to the local loopback service', () => {
  withAxUrl(undefined, () => {
    assert.equal(resolveTimefitAxUrl(), 'http://127.0.0.1:8351');
  });
});

test('Timefit AX URL accepts a production HTTPS origin', () => {
  withAxUrl('https://timefit-ax.example.com/', () => {
    assert.equal(resolveTimefitAxUrl(), 'https://timefit-ax.example.com');
  });
});

test('Timefit AX URL rejects non-loopback HTTP endpoints', () => {
  withAxUrl('http://timefit-ax.example.com', () => {
    assert.throws(resolveTimefitAxUrl, /timefit_ax_https_required/);
  });
});

test('Timefit AX URL rejects credentials, query strings, and fragments', () => {
  for (const value of [
    'https://user:secret@timefit-ax.example.com',
    'https://timefit-ax.example.com?target=other',
    'https://timefit-ax.example.com#fragment',
  ]) {
    withAxUrl(value, () => {
      assert.throws(resolveTimefitAxUrl, /timefit_ax_url_invalid/);
    });
  }
});

test('Timefit AX extraction is normalized for the existing receipt pipeline', () => {
  const result = normalizeTimefitAxExtraction({
    documentType: 'receipt', merchantName: '테스트 상점', transactionDate: '2026-10-09', transactionTime: '12:34',
    totalAmount: 12000, merchantBusinessNumber: '123-45-67890', approvalNumber: 'A123', cardLast4: '4321',
    currency: 'KRW', confidence: 0.9, warnings: ['부가세 확인 필요'],
    lineItems: [{ name: '아메리카노', quantity: 2, unitPrice: 6000, amount: 12000 }],
  });
  assert.equal(result.extractionProvider, 'timefit_ax_codex');
  assert.equal(result.merchantName, '테스트 상점');
  assert.equal(result.lineItems[0].itemNameRaw, '아메리카노');
  assert.equal(result.lineItems[0].lineAmount, 12000);
  assert.deepEqual(result.warnings, ['부가세 확인 필요']);
});

test('Timefit AX receives only server-generated signed document URLs', async () => {
  const previous = {
    url: process.env.TIMEFIT_AX_URL,
    key: process.env.TIMEFIT_AX_TRANSPORT_KEY,
    allowedHosts: process.env.TIMEFIT_AX_ALLOWED_HOSTS,
    supabaseUrl: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    fetch: global.fetch,
  };
  process.env.TIMEFIT_AX_URL = 'https://tunnel.example.com/timefit-ax';
  process.env.TIMEFIT_AX_ALLOWED_HOSTS = 'tunnel.example.com';
  process.env.TIMEFIT_AX_TRANSPORT_KEY = '01234567890123456789012345678901';
  process.env.SUPABASE_URL = 'https://project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) return new Response(JSON.stringify({ signedURL: '/object/sign/timefit-finance-documents/org/receipt.jpg?token=signed' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({
      requestId: 'receipt:doc-1:run-1', state: 'SUCCEEDED', imageContentSha256: 'abc123',
      extraction: {
        documentType: 'receipt', merchantName: '상점', merchantBusinessNumber: null, transactionDate: '2026-10-09', transactionTime: null,
        totalAmount: 5000, approvalNumber: null, cardLast4: null, currency: 'KRW', rawText: '상점\n5,000',
        lineItems: [], confidence: 0.8, warnings: [],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await extractReceiptWithTimefitAx({ organizationId: 'org-1', documentId: 'doc-1', runId: 'run-1', storagePaths: ['org/receipt.jpg'] });
    assert.equal(result.extracted.merchantName, '상점');
    assert.equal(calls[0].url, 'https://project.supabase.co/storage/v1/object/sign/timefit-finance-documents/org/receipt.jpg');
    const request = JSON.parse(calls[1].options.body);
    assert.equal(calls[1].url, 'https://tunnel.example.com/timefit-ax/api/timefit/v1/receipt-sessions');
    assert.deepEqual(request.imageUrls, ['https://project.supabase.co/storage/v1/object/sign/timefit-finance-documents/org/receipt.jpg?token=signed']);
    assert.equal(calls[1].options.headers['X-Timefit-Ax-Key'], process.env.TIMEFIT_AX_TRANSPORT_KEY);
  } finally {
    global.fetch = previous.fetch;
    for (const [name, value] of [['TIMEFIT_AX_URL', previous.url], ['TIMEFIT_AX_ALLOWED_HOSTS', previous.allowedHosts], ['TIMEFIT_AX_TRANSPORT_KEY', previous.key], ['SUPABASE_URL', previous.supabaseUrl], ['SUPABASE_SERVICE_ROLE_KEY', previous.serviceKey]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
