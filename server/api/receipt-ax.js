import { randomUUID } from 'node:crypto';
import { authorizeFinance, authorizeOrganizationMember, financeError, financeRest, financeServerConfigured, methodNotAllowed } from './_finance-server.js';

const localAxUrl = () => {
  const value = String(process.env.TIMEFIT_AX_URL || 'http://127.0.0.1:8351').replace(/\/$/, '');
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) throw new Error('timefit_ax_must_be_loopback');
  return value;
};

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
  const imageUrls = Array.isArray(req.body?.imageUrls)
    ? req.body.imageUrls.map(value => String(value || ''))
    : req.body?.imageUrl ? [String(req.body.imageUrl)] : [];
  if (!organizationId || !documentId || !imageUrls.length || imageUrls.length > 20 || imageUrls.some(url => !url || url.length > 4096)) {
    return res.status(400).json({ ok: false, error: '영수증 문서와 이미지 URL을 확인해 주세요.' });
  }
  try {
    const documents = await financeRest(`timefit_user_finance_documents?id=eq.${encodeURIComponent(documentId)}&organization_id=eq.${encodeURIComponent(organizationId)}&document_type=eq.receipt&select=id,organization_id,uploaded_by,extracted_data`);
    const document = documents[0];
    if (!document) return res.status(404).json({ ok: false, error: '영수증 문서를 찾을 수 없습니다.' });
    const auth = await authorizeDocument(req, document);
    if (!auth) return res.status(req.headers.authorization ? 403 : 401).json({ ok: false, error: '영수증 분석 권한이 없습니다.' });
    const requestId = String(req.body?.requestId || `receipt:${documentId}:${randomUUID()}`);
    const response = await fetch(`${localAxUrl()}/api/timefit/v1/receipt-sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Timefit-Ax-Key': process.env.TIMEFIT_AX_TRANSPORT_KEY },
      body: JSON.stringify({ requestId, organizationId, documentId, imageUrls }),
      signal: AbortSignal.timeout(Number(process.env.TIMEFIT_AX_REQUEST_TIMEOUT_MS || 240000)),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.state !== 'SUCCEEDED' || !payload.extraction) {
      const error = new Error(payload.error || payload.errorCode || `timefit_ax_${response.status}`); error.status = response.status; throw error;
    }
    const extraction = { ...payload.extraction, extractionProvider: 'timefit_ax_codex', axRequestId: requestId, imageContentSha256: payload.imageContentSha256 || null };
    await financeRest(`timefit_user_finance_documents?id=eq.${encodeURIComponent(documentId)}&organization_id=eq.${encodeURIComponent(organizationId)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
        extracted_data: extraction,
        ocr_text: String(extraction.rawText || '').slice(0, 50000),
        processing_status: 'ready',
        review_status: 'submitter_review',
        processing_error: null,
        document_date: extraction.transactionDate || null,
        processed_at: new Date().toISOString(),
      }),
    });
    await financeRest('timefit_user_expense_audit_logs', {
      method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{
        organization_id: organizationId, entity_type: 'finance_document', entity_id: documentId,
        action: 'timefit_ax_extracted', before_value: document.extracted_data || null,
        after_value: extraction, actor_id: auth.user.id, source: 'system',
      }]),
    });
    return res.status(200).json({ ok: true, requestId, documentId, extraction });
  } catch (error) {
    return financeError(res, error, 'Timefit AX 영수증 분석을 완료하지 못했습니다.');
  }
}
