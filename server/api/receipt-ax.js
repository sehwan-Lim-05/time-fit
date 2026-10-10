import { authorizeFinance, authorizeOrganizationMember, financeError, financeRest, financeServerConfigured, methodNotAllowed } from './_finance-server.js';
import { extractReceiptWithTimefitAx, normalizedRequestId } from './_timefit-ax.js';

export { axBaseUrl, axTimeout, normalizeImageUrls, normalizedRequestId } from './_timefit-ax.js';

const FINAL_REVIEW_STATES = new Set(['approved', 'rejected', 'withdrawn']);

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
    const requestId = normalizedRequestId(req.body?.requestId, documentId);
    const documents = await financeRest(`timefit_user_finance_documents?id=eq.${encodeURIComponent(documentId)}&organization_id=eq.${encodeURIComponent(organizationId)}&document_type=eq.receipt&select=id,organization_id,uploaded_by,extracted_data,storage_path,mime_type,processing_status,review_status`);
    document = documents[0];
    if (!document) return res.status(404).json({ ok: false, error: '영수증 문서를 찾을 수 없습니다.' });
    const auth = await authorizeDocument(req, document);
    if (!auth) return res.status(req.headers.authorization ? 403 : 401).json({ ok: false, error: '영수증 분석 권한이 없습니다.' });
    authorized = true;
    if (FINAL_REVIEW_STATES.has(document.review_status)) return res.status(409).json({ ok: false, error: '검토가 종료된 영수증은 다시 분석할 수 없습니다.' });
    const pages = await financeRest(`timefit_user_finance_document_pages?document_id=eq.${encodeURIComponent(documentId)}&select=storage_path,mime_type&page_number=not.is.null&order=page_number.asc`);
    const sourcePages = pages.length ? pages : [{ storage_path: document.storage_path, mime_type: document.mime_type }];
    if (sourcePages.some(page => !String(page.mime_type || '').startsWith('image/'))) return res.status(400).json({ ok: false, error: '이미지 영수증만 분석할 수 있습니다.' });
    await financeRest(`timefit_user_finance_documents?id=eq.${encodeURIComponent(documentId)}&organization_id=eq.${encodeURIComponent(organizationId)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ processing_status: 'processing', processing_error: null }),
    });
    const result = await extractReceiptWithTimefitAx({ organizationId, documentId, requestId, storagePaths: sourcePages.map(page => page.storage_path) });
    const currentAuth = await authorizeDocument(req, document);
    if (!currentAuth) { const error = new Error('timefit_ax_authorization_revoked'); error.status = 403; throw error; }
    const extraction = { ...result.extracted, rawText: result.rawText, axRequestId: result.requestId, imageContentSha256: result.imageContentSha256 };
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
    if (error.message === 'timefit_ax_request_id_invalid') return res.status(400).json({ ok: false, error: '영수증 요청 식별자를 확인해 주세요.' });
    if (error.status === 403) return res.status(403).json({ ok: false, error: '영수증 분석 권한이 취소되었습니다.' });
    return financeError(res, error, 'Timefit AX 영수증 분석을 완료하지 못했습니다.');
  }
}
