import { serviceHeaders } from './_finance-server.js';
import { validateReceiptExtraction } from './_receipt-llm.js';

const STORAGE_BUCKET = 'timefit-finance-documents';

export function resolveTimefitAxUrl() {
  const value = String(process.env.TIMEFIT_AX_URL || 'http://127.0.0.1:8351').replace(/\/$/, '');
  const url = new URL(value);
  const isLoopbackHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !isLoopbackHttp) throw new Error('timefit_ax_url_must_be_https_or_loopback');
  if (url.username || url.password || url.search || url.hash) throw new Error('timefit_ax_url_must_be_a_clean_base_url');
  return value;
}

export function timefitAxConfigured() {
  return Boolean(process.env.TIMEFIT_AX_URL && process.env.TIMEFIT_AX_TRANSPORT_KEY?.length >= 32);
}

function encodedStoragePath(path) {
  const value = String(path || '').replace(/^\/+/, '');
  if (!value || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('timefit_ax_storage_path_invalid');
  return value.split('/').map(encodeURIComponent).join('/');
}

function absoluteSignedUrl(value) {
  const signed = String(value || '');
  if (!signed) throw new Error('timefit_ax_signed_url_missing');
  if (/^https:\/\//i.test(signed)) return signed;
  const path = signed.startsWith('/storage/v1/') ? signed : signed.startsWith('/object/') ? `/storage/v1${signed}` : `/storage/v1/${signed.replace(/^\/+/, '')}`;
  return new URL(path, `${process.env.SUPABASE_URL}/`).toString();
}

export async function createTimefitAxSignedUrl(storagePath, expiresIn = 600) {
  const response = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/sign/${STORAGE_BUCKET}/${encodedStoragePath(storagePath)}`, {
    method: 'POST',
    headers: serviceHeaders(),
    body: JSON.stringify({ expiresIn }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`timefit_ax_sign_${response.status}`);
  return absoluteSignedUrl(payload.signedURL || payload.signedUrl);
}

export function normalizeTimefitAxExtraction(value = {}) {
  const confidence = Math.max(0, Math.min(1, Number(value.confidence) || 0));
  const normalized = validateReceiptExtraction({
    merchantName: value.merchantName,
    transactionDate: value.transactionDate,
    transactionTime: value.transactionTime,
    totalAmount: value.totalAmount,
    supplyAmount: null,
    vatAmount: null,
    taxFreeAmount: null,
    merchantBusinessNumber: value.merchantBusinessNumber,
    approvalNumber: value.approvalNumber,
    cardLast4: value.cardLast4,
    paymentMethod: null,
    category: null,
    confidence,
    fieldConfidence: {
      merchantName: confidence,
      transactionDate: confidence,
      totalAmount: confidence,
      paymentMethod: 0,
    },
    lineItems: (Array.isArray(value.lineItems) ? value.lineItems : []).map(item => ({
      rawText: String(item?.name || ''),
      itemName: item?.name,
      quantity: item?.quantity,
      unit: null,
      unitPrice: item?.unitPrice,
      discountAmount: 0,
      lineAmount: item?.amount,
      taxType: 'unknown',
      confidence,
    })),
  });
  return {
    ...normalized,
    documentType: value.documentType || 'unknown',
    currency: value.currency || 'UNKNOWN',
    warnings: Array.isArray(value.warnings) ? value.warnings.map(item => String(item)).slice(0, 20) : [],
    extractionProvider: 'timefit_ax_codex',
  };
}

export async function extractReceiptWithTimefitAx({ organizationId, documentId, runId, requestId: suppliedRequestId, storagePaths }) {
  if (!timefitAxConfigured()) throw new Error('timefit_ax_not_configured');
  if (!Array.isArray(storagePaths) || !storagePaths.length || storagePaths.length > 20) throw new Error('timefit_ax_images_invalid');
  const imageUrls = [];
  for (const storagePath of storagePaths) imageUrls.push(await createTimefitAxSignedUrl(storagePath));
  const requestId = suppliedRequestId || `receipt:${documentId}:${runId}`;
  const response = await fetch(`${resolveTimefitAxUrl()}/api/timefit/v1/receipt-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Timefit-Ax-Key': process.env.TIMEFIT_AX_TRANSPORT_KEY },
    body: JSON.stringify({ requestId, organizationId, documentId, imageUrls }),
    signal: AbortSignal.timeout(Number(process.env.TIMEFIT_AX_REQUEST_TIMEOUT_MS || 240000)),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.state !== 'SUCCEEDED' || !payload.extraction) {
    throw new Error(String(payload.error || payload.errorCode || `timefit_ax_${response.status}`).slice(0, 300));
  }
  return {
    requestId,
    rawText: String(payload.extraction.rawText || ''),
    extracted: normalizeTimefitAxExtraction(payload.extraction),
    imageContentSha256: payload.imageContentSha256 || null,
    model: 'codex-cli',
  };
}
