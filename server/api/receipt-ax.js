import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { authorizeFinance, authorizeOrganizationMember, financeError, financeRest, financeServerConfigured, methodNotAllowed } from './_finance-server.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const FINAL_REVIEW_STATES = new Set(['approved', 'rejected', 'withdrawn']);
const MAX_AX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/;
const hostList = value => new Set(String(value || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean));

function isPrivateIp(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (!isIP(host)) return false;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (host.includes(':')) return /^(fc|fd|fe8|fe9|fea|feb)/i.test(host);
  const [a, b] = host.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function axBaseUrl({ value = process.env.TIMEFIT_AX_URL, nodeEnv = process.env.NODE_ENV, allowedHosts = process.env.TIMEFIT_AX_ALLOWED_HOSTS } = {}) {
  const raw = String(value || (nodeEnv === 'production' ? '' : 'http://127.0.0.1:8351')).trim().replace(/\/$/, '');
  if (!raw) throw new Error('timefit_ax_url_required');
  const url = new URL(raw);
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.username || url.password || url.search || url.hash) throw new Error('timefit_ax_url_invalid');
  if (loopback) {
    if (nodeEnv === 'production' || url.protocol !== 'http:') throw new Error('timefit_ax_loopback_development_only');
  } else {
    if (url.protocol !== 'https:' || isPrivateIp(url.hostname)) throw new Error('timefit_ax_https_required');
    const hosts = hostList(allowedHosts);
    if (!hosts.size || !hosts.has(url.hostname.toLowerCase())) throw new Error('timefit_ax_host_not_allowed');
  }
  return url.toString().replace(/\/$/, '');
}

export function normalizeImageUrls(input, { nodeEnv = process.env.NODE_ENV } = {}) {
  const values = Array.isArray(input?.imageUrls) ? input.imageUrls : input?.imageUrl ? [input.imageUrl] : [];
  if (!values.length || values.length > 20) throw new Error('receipt_image_urls_invalid');
  return values.map(value => {
    const raw = String(value || '').trim();
    if (!raw || raw.length > 4096) throw new Error('receipt_image_url_invalid');
    let url;
    try { url = new URL(raw); } catch { throw new Error('receipt_image_url_invalid'); }
    const loopback = LOOPBACK_HOSTS.has(url.hostname);
    if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(nodeEnv !== 'production' && loopback && url.protocol === 'http:')) || (!loopback && isPrivateIp(url.hostname))) {
      throw new Error('receipt_image_url_unsafe');
    }
    return url.toString();
  });
}

export function normalizedRequestId(value, documentId) {
  const requestId = String(value || `receipt:${documentId}:${randomUUID()}`);
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error('timefit_ax_request_id_invalid');
  return requestId;
}

export function axTimeout(value = process.env.TIMEFIT_AX_REQUEST_TIMEOUT_MS) {
  const timeout = Number(value || 55000);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 55000) throw new Error('timefit_ax_timeout_invalid');
  return timeout;
}

function validExtraction(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.rawText != null && (typeof value.rawText !== 'string' || value.rawText.length > 100000)) return false;
  if (value.transactionDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(value.transactionDate))) return false;
  if (value.totalAmount != null && (!Number.isFinite(Number(value.totalAmount)) || Number(value.totalAmount) < 0)) return false;
  return true;
}

async function readAxPayload(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_AX_RESPONSE_BYTES) throw new Error('timefit_ax_response_too_large');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_AX_RESPONSE_BYTES) throw new Error('timefit_ax_response_too_large');
  try { return text ? JSON.parse(text) : {}; } catch { throw new Error('timefit_ax_response_invalid'); }
}

async function authorizeDocument(req, document) {
  const member = await authorizeOrganizationMember(req, document.organization_id);
  if (member?.user?.id === document.uploaded_by) return member;
  return authorizeFinance(req, document.organization_id, { permissionsAny: ['expense.receipt.review', 'expense.manage'] });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  if (!financeServerConfigured()) return res.status(503).json({ ok: false, error: 'Supabase 서버 설정이 필요합니다.' });
  if (!process.env.TIMEFIT_AX_TRANSPORT_KEY || process.env.TIMEFIT_AX_TRANSPORT_KEY.length < 32) {
    return res.status(503).json({ ok: false, error: 'Timefit AX 공유키 설정이 필요합니다.' });
  }
  const organizationId = String(req.body?.organizationId || '');
  const documentId = String(req.body?.documentId || '');
  if (!organizationId || !documentId) return res.status(400).json({ ok: false, error: '영수증 문서를 확인해 주세요.' });
  let document = null;
  let authorized = false;
  try {
    const imageUrls = normalizeImageUrls(req.body);
    const requestId = normalizedRequestId(req.body?.requestId, documentId);
    const documents = await financeRest(`timefit_user_finance_documents?id=eq.${encodeURIComponent(documentId)}&organization_id=eq.${encodeURIComponent(organizationId)}&document_type=eq.receipt&select=id,organization_id,uploaded_by,extracted_data,processing_status,review_status`);
    document = documents[0];
    if (!document) return res.status(404).json({ ok: false, error: '영수증 문서를 찾을 수 없습니다.' });
    const auth = await authorizeDocument(req, document);
    if (!auth) return res.status(req.headers.authorization ? 403 : 401).json({ ok: false, error: '영수증 분석 권한이 없습니다.' });
    authorized = true;
    if (FINAL_REVIEW_STATES.has(document.review_status)) return res.status(409).json({ ok: false, error: '검토가 종료된 영수증은 다시 분석할 수 없습니다.' });
    await financeRest(`timefit_user_finance_documents?id=eq.${encodeURIComponent(documentId)}&organization_id=eq.${encodeURIComponent(organizationId)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ processing_status: 'processing', processing_error: null }),
    });
    const response = await fetch(`${axBaseUrl()}/api/timefit/v1/receipt-sessions`, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Timefit-Ax-Key': process.env.TIMEFIT_AX_TRANSPORT_KEY },
      body: JSON.stringify({ requestId, organizationId, documentId, imageUrls }),
      signal: AbortSignal.timeout(axTimeout()),
    });
    const payload = await readAxPayload(response);
    if (!response.ok || payload.state !== 'SUCCEEDED' || !validExtraction(payload.extraction)) {
      const error = new Error(payload.error || payload.errorCode || `timefit_ax_${response.status}`); error.status = response.status; throw error;
    }
    const currentAuth = await authorizeDocument(req, document);
    if (!currentAuth) { const error = new Error('timefit_ax_authorization_revoked'); error.status = 403; throw error; }
    const extraction = { ...payload.extraction, extractionProvider: 'timefit_ax_codex', axRequestId: requestId, imageContentSha256: payload.imageContentSha256 || null };
    await financeRest(`timefit_user_finance_documents?id=eq.${encodeURIComponent(documentId)}&organization_id=eq.${encodeURIComponent(organizationId)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
        extracted_data: extraction, ocr_text: String(extraction.rawText || '').slice(0, 50000), processing_status: 'ready',
        review_status: 'submitter_review', processing_error: null, document_date: extraction.transactionDate || null, processed_at: new Date().toISOString(),
      }),
    });
    await financeRest('timefit_user_expense_audit_logs', {
      method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{
        organization_id: organizationId, entity_type: 'finance_document', entity_id: documentId, action: 'timefit_ax_extracted',
        before_value: document.extracted_data || null, after_value: extraction, actor_id: currentAuth.user.id, source: 'system',
      }]),
    });
    return res.status(200).json({ ok: true, requestId, documentId, extraction });
  } catch (error) {
    if (document && authorized) {
      await financeRest(`timefit_user_finance_documents?id=eq.${encodeURIComponent(documentId)}&organization_id=eq.${encodeURIComponent(organizationId)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
          processing_status: 'failed', review_status: 'submitter_review', processing_error: String(error.message || 'timefit_ax_failed').slice(0, 300), processed_at: new Date().toISOString(),
        }),
      }).catch(() => {});
    }
    if (['receipt_image_urls_invalid', 'receipt_image_url_invalid', 'receipt_image_url_unsafe', 'timefit_ax_request_id_invalid'].includes(error.message)) {
      return res.status(400).json({ ok: false, error: '영수증 이미지 URL 또는 요청 식별자를 확인해 주세요.' });
    }
    if (error.status === 403) return res.status(403).json({ ok: false, error: '영수증 분석 권한이 취소되었습니다.' });
    return financeError(res, error, 'Timefit AX 영수증 분석을 완료하지 못했습니다.');
  }
}
