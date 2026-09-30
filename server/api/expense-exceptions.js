import { authorizeFinance, financeError, financeRest, financeServerConfigured, methodNotAllowed } from './_finance-server.js';

const ageDays = (value, now) => Math.max(0, Math.floor((now.getTime() - new Date(value).getTime()) / 86400000));
const severityRank = { critical: 3, warning: 2, info: 1 };

export function buildExpenseExceptions({ transactions = [], documents = [], connections = [], closeouts = [], reminders = [], now = new Date() }) {
  const reminderCounts = reminders.reduce((map, item) => {
    map.set(item.transaction_group_id, Math.max(map.get(item.transaction_group_id) || 0, Number(item.reminder_number || 0)));
    return map;
  }, new Map());
  const items = [
    ...transactions.map(item => { const age = ageDays(item.approved_at, now); const reminderCount = reminderCounts.get(item.id) || 0; return { id: `transaction:${item.id}`, type: 'missing_receipt', severity: age >= 7 ? 'critical' : age >= 3 ? 'warning' : 'info', title: `${item.merchant_name || '사용처 미확인'} 영수증 미제출`, description: `${item.card?.nickname || item.card?.issuer || '법인카드'} •••• ${item.card?.last4 || '----'} · ${Number(item.net_amount || 0).toLocaleString('ko-KR')}원${reminderCount ? ` · 알림 ${reminderCount}회` : ''}`, occurredAt: item.approved_at, ageDays: age, reminderCount, owner: item.card?.holder?.display_name || '공용 카드', target: 'cards' }; }),
    ...documents.map(item => {
      const failed = item.processing_status === 'failed';
      const processing = ['uploaded','queued','processing'].includes(item.processing_status);
      const age = ageDays(item.created_at, now);
      return {
        id: `document:${item.id}`, type: failed ? 'ocr_failed' : 'receipt_review', severity: failed || age >= 3 ? 'critical' : processing ? 'info' : 'warning',
        title: failed ? `${item.title} OCR 처리 실패` : processing ? `${item.title} 분석 중` : `${item.title} 검토 필요`,
        description: failed ? item.processing_error || 'OCR 처리 상태를 확인해 주세요.' : processing ? '원본 저장 완료 · 문자와 결제정보를 분석하고 있습니다.' : `${item.extracted_data?.merchantName || '사용처 확인 필요'} · ${Number(item.extracted_data?.totalAmount || 0).toLocaleString('ko-KR')}원`,
        occurredAt: item.created_at, ageDays: age, owner: '관리자', target: 'receipts', processingStatus: item.processing_status, reviewStatus: item.review_status,
      };
    }),
    ...connections.map(item => ({ id: `connection:${item.id}`, type: 'card_connection', severity: item.status === 'reauth_required' ? 'critical' : 'warning', title: item.status === 'reauth_required' ? `${item.provider} 재인증 필요` : `${item.provider} 자동수집 장애`, description: item.last_error_code || '최근 카드 동기화 상태를 확인해 주세요.', occurredAt: item.last_attempted_at || item.updated_at, ageDays: ageDays(item.last_attempted_at || item.updated_at, now), owner: '사업장 소유자', target: 'connections' })),
    ...closeouts.map(item => ({ id: `closeout:${item.id}`, type: 'closeout_draft', severity: 'info', title: `${item.period_start} ~ ${item.period_end} 결산 미완료`, description: `버전 ${item.version} · ${item.summary?.payrollComplete === false ? '급여 초안 확인 필요' : '증빙 검토 필요'}`, occurredAt: item.updated_at, ageDays: ageDays(item.updated_at, now), owner: '사업장 소유자', target: 'closeouts' })),
  ];
  items.sort((a, b) => severityRank[b.severity] - severityRank[a.severity] || b.ageDays - a.ageDays || String(a.occurredAt).localeCompare(String(b.occurredAt)));
  return { items, summary: { total: items.length, critical: items.filter(item => item.severity === 'critical').length, warning: items.filter(item => item.severity === 'warning').length, missingReceipts: items.filter(item => item.type === 'missing_receipt').length, receiptReviews: items.filter(item => ['receipt_review','ocr_failed'].includes(item.type)).length, connectionIssues: items.filter(item => item.type === 'card_connection').length } };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  if (!financeServerConfigured()) return res.status(503).json({ ok: false, error: '금융 처리 서버 설정이 필요합니다.' });
  const { organizationId } = req.query || {}; const auth = await authorizeFinance(req, organizationId);
  if (!auth) return res.status(req.headers.authorization ? 403 : 401).json({ ok: false, error: '관리자 인증이 필요합니다.' });
  try {
    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
    const [transactions, documents, connections, closeouts, reminders] = await Promise.all([
      financeRest(`timefit_user_card_transaction_groups?organization_id=eq.${encodeURIComponent(organizationId)}&reconciliation_status=eq.unreviewed&net_amount=gt.0&approved_at=gte.${encodeURIComponent(cutoff)}&select=id,merchant_name,net_amount,approved_at,card:timefit_user_corporate_cards(issuer,nickname,last4,holder:timefit_user_staff(display_name))&order=approved_at.asc&limit=100`),
      financeRest(`timefit_user_finance_documents?organization_id=eq.${encodeURIComponent(organizationId)}&document_type=eq.receipt&or=(processing_status.in.(uploaded,queued,processing,failed),review_status.in.(submitted,submitter_review,manager_review,change_requested,resubmitted))&select=id,title,processing_status,review_status,processing_error,extracted_data,created_at&order=created_at.asc&limit=100`),
      financeRest(`timefit_user_card_connections?organization_id=eq.${encodeURIComponent(organizationId)}&status=in.(degraded,reauth_required)&select=id,provider,status,last_error_code,last_attempted_at,updated_at&order=updated_at.asc`),
      financeRest(`timefit_user_closeouts?organization_id=eq.${encodeURIComponent(organizationId)}&status=in.(draft,reopened)&select=id,period_start,period_end,version,status,summary,updated_at&order=updated_at.asc&limit=30`),
      financeRest(`timefit_user_expense_receipt_reminders?organization_id=eq.${encodeURIComponent(organizationId)}&status=in.(sent,read)&select=transaction_group_id,reminder_number&limit=1000`),
    ]);
    return res.status(200).json({ ok: true, ...buildExpenseExceptions({ transactions, documents, connections, closeouts, reminders }) });
  } catch (error) { return financeError(res, error, '지출 예외 업무함을 불러오지 못했습니다.'); }
}
