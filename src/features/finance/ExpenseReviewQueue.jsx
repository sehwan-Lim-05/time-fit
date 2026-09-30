import React, { useEffect, useRef, useState } from 'react';
import {
  approveReceiptExpense,
  bulkConfirmExpenseMatches,
  excludeExpenseDraft,
  loadCostCenters,
  loadExpenseReviewQueue,
  openFinanceDocument,
  processReceiptDocument,
  confirmReceiptSubmission,
  requestReceiptChange,
  reviewExpenseMatch,
  updateExpenseDraft,
} from '../../lib/supabase';
import { readViewCache, writeViewCache } from '../../lib/viewCache';

const money = value => new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(Number(value) || 0);
const REVIEW_CACHE_TTL_MS = 5 * 60_000;

export default function ExpenseReviewQueue({ organizationId, accountId = '', canReview = true, focusDocumentId = '', refreshToken = 0 }) {
  const initialCacheKey = `expense-review:${accountId || 'account'}:${organizationId}:attention:all`;
  const initialDocuments = readViewCache(initialCacheKey, Date.now(), REVIEW_CACHE_TTL_MS);
  const [documents, setDocuments] = useState(initialDocuments || []);
  const [loading, setLoading] = useState(!initialDocuments);
  const [busyId, setBusyId] = useState('');
  const [expandedId, setExpandedId] = useState('');
  const [message, setMessage] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [costCenters, setCostCenters] = useState([]);
  const [costCenterId, setCostCenterId] = useState('');
  const [status, setStatus] = useState('attention');
  const [originalUrls, setOriginalUrls] = useState({});
  const focusedDocumentId = useRef('');
  const cacheKey = `expense-review:${accountId || 'account'}:${organizationId}:${status}:${costCenterId || 'all'}`;

  const applyDocuments = next => {
    setDocuments(next);
    const available = new Set(next.map(item => item.matches?.[0]).filter(match => match?.status === 'suggested' && Number(match.score) >= 95).map(match => match.id));
    setSelectedIds(ids => ids.filter(id => available.has(id)));
  };
  const refresh = async ({ preserve = false } = {}) => {
    if (!organizationId) return;
    if (!preserve) setLoading(true);
    try { const next = await loadExpenseReviewQueue(organizationId, status, costCenterId); writeViewCache(cacheKey, next); applyDocuments(next); }
    catch (error) { setMessage(error.message || '확인 필요 영수증을 불러오지 못했습니다.'); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    const cached = readViewCache(cacheKey, Date.now(), REVIEW_CACHE_TTL_MS);
    if (cached) { applyDocuments(cached); setLoading(false); refresh({ preserve: true }); return; }
    setDocuments([]);
    refresh();
  }, [cacheKey]);
  useEffect(() => { if (refreshToken > 0) refresh({ preserve: true }); }, [refreshToken]);
  useEffect(() => {
    if (!documents.some(item => ['uploaded','queued','processing'].includes(item.processing_status))) return undefined;
    const timer = window.setInterval(() => refresh({ preserve: true }), 3000);
    return () => window.clearInterval(timer);
  }, [documents, cacheKey]);
  useEffect(() => { if (organizationId) loadCostCenters(organizationId).then(setCostCenters).catch(() => setCostCenters([])); }, [organizationId]);
  useEffect(() => {
    if (!focusDocumentId || loading || focusedDocumentId.current === focusDocumentId) return;
    const targetDocument = documents.find(item => item.id === focusDocumentId);
    if (!targetDocument) return;
    focusedDocumentId.current = focusDocumentId;
    setExpandedId(focusDocumentId);
    if (!originalUrls[focusDocumentId]) openFinanceDocument(targetDocument.storage_path).then(url => setOriginalUrls(urls => ({ ...urls, [focusDocumentId]: url }))).catch(error => setMessage(error.message || '영수증 원본을 불러오지 못했습니다.'));
    requestAnimationFrame(() => window.document.getElementById(`expense-review-${focusDocumentId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, [documents, focusDocumentId, loading, originalUrls]);

  const toggleExpanded = async document => {
    if (expandedId === document.id) { setExpandedId(''); return; }
    setExpandedId(document.id);
    if (!originalUrls[document.id]) {
      try { const url = await openFinanceDocument(document.storage_path); setOriginalUrls(urls => ({ ...urls, [document.id]: url })); }
      catch (error) { setMessage(error.message || '영수증 원본을 불러오지 못했습니다.'); }
    }
  };

  const review = async (document, match, action) => {
    if (action === 'confirm' && !window.confirm(`${match.transaction?.merchant_name || '카드 거래'}와 영수증을 한 지출로 확정할까요?`)) return;
    setBusyId(match.id); setMessage('');
    try {
      await reviewExpenseMatch({ organizationId, matchId: match.id, action });
      setMessage(action === 'confirm' ? '카드 거래와 영수증을 하나의 지출로 확정했어요.' : action === 'unlink' ? '카드 거래 연결을 해제했어요.' : '잘못된 후보를 반려했어요.');
      await refresh({ preserve: true });
    } catch (error) { setMessage(error.message || '검토 결과를 저장하지 못했습니다.'); }
    finally { setBusyId(''); }
  };

  const save = async (event, match) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusyId(match.expense.id); setMessage('');
    try {
      await updateExpenseDraft({ organizationId, expenseId: match.expense.id, transactionDate: form.get('transactionDate'), totalAmount: form.get('totalAmount'), merchantName: form.get('merchantName'), merchantBusinessNumber: form.get('merchantBusinessNumber'), category: form.get('category'), reason: form.get('reason'), rememberRule: form.get('rememberRule') === 'on' });
      setMessage(form.get('rememberRule') === 'on' ? '지출 정보를 수정하고 다음 영수증 자동 분류 규칙을 저장했어요.' : 'OCR 지출 정보를 수정했어요.'); await refresh({ preserve: true });
    } catch (error) { setMessage(error.message || '지출 정보를 수정하지 못했습니다.'); }
    finally { setBusyId(''); }
  };

  const saveDocument = async (event, document) => {
    event.preventDefault(); const form = new FormData(event.currentTarget); setBusyId(document.id); setMessage('수정 내용을 저장하고 다시 분석하고 있어요.');
    try { await confirmReceiptSubmission({ organizationId, documentId: document.id, patch: { merchantName: form.get('merchantName'), transactionDate: form.get('transactionDate'), totalAmount: form.get('totalAmount'), costCenterId: form.get('costCenterId'), paymentMethod: form.get('paymentMethod') } }); setMessage('기본 정보를 저장했어요. OCR과 카드 내역을 다시 대조합니다.'); await refresh({ preserve: true }); }
    catch (error) { setMessage(error.message || '영수증 기본 정보를 저장하지 못했습니다.'); }
    finally { setBusyId(''); }
  };

  const exclude = async document => {
    const expense = document.matches?.[0]?.expense || document.expense;
    if (!expense || !window.confirm('이 영수증을 지출 집계에서 제외할까요?')) return;
    setBusyId(expense.id); setMessage('');
    try { await excludeExpenseDraft({ organizationId, expenseId: expense.id }); setMessage('영수증을 지출 집계에서 제외했어요.'); await refresh({ preserve: true }); }
    catch (error) { setMessage(error.message || '영수증을 제외하지 못했습니다.'); }
    finally { setBusyId(''); }
  };

  const openOriginal = async document => {
    try { window.open(await openFinanceDocument(document.storage_path), '_blank', 'noopener,noreferrer'); }
    catch (error) { setMessage(error.message || '영수증 원본을 열지 못했습니다.'); }
  };

  const bulkConfirm = async () => {
    if (!selectedIds.length || !window.confirm(`고신뢰 영수증 ${selectedIds.length}건을 카드 거래와 일괄 확정할까요?`)) return;
    setBusyId('bulk'); setMessage('');
    try { const result = await bulkConfirmExpenseMatches({ organizationId, matchIds: selectedIds }); setMessage(`${result.confirmed}건을 일괄 확정했어요.${result.failed ? ` 실패 ${result.failed}건은 목록에 유지됩니다.` : ''}`); setSelectedIds([]); await refresh({ preserve: true }); }
    catch (error) { setMessage(error.message || '일괄 확정을 완료하지 못했습니다.'); }
    finally { setBusyId(''); }
  };

  const retry = async document => {
    setBusyId(document.id); setMessage('영수증을 다시 분석하고 있어요.');
    try { await processReceiptDocument({ organizationId, documentId: document.id }); setMessage('재분석을 완료했어요. 결과를 확인해 주세요.'); await refresh({ preserve: true }); }
    catch (error) { setMessage(error.message || '영수증 재분석을 완료하지 못했습니다.'); await refresh({ preserve: true }); }
    finally { setBusyId(''); }
  };

  const requestChange = async document => {
    const reason = window.prompt('직원이 수정해야 할 내용을 입력해 주세요.');
    if (!reason) return;
    setBusyId(document.id); setMessage('');
    try { await requestReceiptChange({ organizationId, documentId: document.id, reason }); setMessage('직원에게 수정 요청을 보냈어요.'); await refresh({ preserve: true }); }
    catch (error) { setMessage(error.message || '수정 요청을 저장하지 못했습니다.'); }
    finally { setBusyId(''); }
  };

  const approveWithoutCard = async (document, expense) => {
    if (!expense || !window.confirm('카드 거래 연결 없이 이 지출을 확정할까요?')) return;
    setBusyId(document.id); setMessage('');
    try { await approveReceiptExpense({ organizationId, documentId: document.id, expenseId: expense.id }); setMessage('영수증 지출을 확정했어요.'); await refresh({ preserve: true }); }
    catch (error) { setMessage(error.message || '지출을 확정하지 못했습니다.'); }
    finally { setBusyId(''); }
  };

  return <section className="card full-card expense-review-queue">
    <div className="card-title"><div><h2>확인 필요 영수증</h2><p>OCR 결과와 카드 후보를 비교해 예외만 처리하세요. 확정하면 하나의 지출로 합쳐집니다.</p></div><span className="count">{documents.length}</span></div>
    <div className="receipt-review-filters"><label>처리 상태<select value={status} onChange={event => setStatus(event.target.value)}><option value="attention">확인 필요</option><option value="processing">분석 중</option><option value="submitter_review">기본정보 확인</option><option value="manager_review">관리자 검토</option><option value="change_requested">수정 요청</option><option value="approved">승인 완료</option><option value="failed">분석 실패</option></select></label><label>소속·부서<select value={costCenterId} onChange={event => setCostCenterId(event.target.value)}><option value="">전체 부서</option>{costCenters.map(center => <option key={center.id} value={center.id}>{center.name}</option>)}</select></label></div>
    {canReview && documents.some(item => Number(item.matches?.[0]?.score) >= 95) && <div className="expense-bulk-review"><label><input type="checkbox" checked={selectedIds.length > 0 && selectedIds.length === documents.filter(item => item.matches?.[0]?.status === 'suggested' && Number(item.matches?.[0]?.score) >= 95).length} onChange={event => setSelectedIds(event.target.checked ? documents.map(item => item.matches?.[0]).filter(match => match?.status === 'suggested' && Number(match.score) >= 95).map(match => match.id) : [])}/><span>95점 이상 최상위 후보 전체 선택</span></label><button className="submit" disabled={!selectedIds.length || Boolean(busyId)} onClick={bulkConfirm}>{busyId === 'bulk' ? '확정 중…' : `${selectedIds.length}건 일괄 확정`}</button></div>}
    {message && <div className={/못|이미|오류/.test(message) ? 'connection-error' : 'expense-review-success'}><span>{message}</span><button onClick={() => setMessage('')}>닫기</button></div>}
    {loading ? <div className="empty-inline">영수증 검토함을 불러오는 중…</div> : documents.length ? documents.map(document => {
      const topMatch = document.matches?.[0]; const expense = topMatch?.expense || document.expense; const extracted = document.extracted_data || {}; const expanded = expandedId === document.id;
      if (['uploaded','queued','processing'].includes(document.processing_status)) return <article className="expense-review-item" key={document.id}><div className="expense-review-summary"><div><b>{document.title}</b><span>원본 저장 완료 · 문자와 기본 결제정보를 확인하고 있어요.</span></div><div className="expense-review-actions"><button className="outline" onClick={() => openOriginal(document)}>원본 보기</button><button className="outline" disabled={Boolean(busyId)} onClick={() => retry(document)}>{busyId === document.id ? '확인 중…' : '처리 상태 확인'}</button></div></div></article>;
      if (document.processing_status === 'failed') return <article className="expense-review-item failed" key={document.id}><div className="expense-review-summary"><div><b>{document.title}</b><span>OCR 자동 분석 실패 · 원본은 안전하게 보관 중</span></div><div className="expense-review-actions"><button className="outline" onClick={() => openOriginal(document)}>원본 보기</button><button className="submit" disabled={Boolean(busyId)} onClick={() => retry(document)}>{busyId === document.id ? '재분석 중…' : '다시 분석'}</button></div></div><div className="receipt-processing-error"><b>실패 원인</b><span>{document.processing_error || '외부 분석 서비스 응답을 확인해 주세요.'}</span></div></article>;
      return <article className="expense-review-item" id={`expense-review-${document.id}`} key={document.id}>
        <div className="expense-review-summary">{topMatch?.status === 'suggested' && Number(topMatch.score) >= 95 && <input className="expense-select" type="checkbox" aria-label={`${extracted.merchantName || document.title} 일괄 확정 선택`} checked={selectedIds.includes(topMatch.id)} onChange={event => setSelectedIds(ids => event.target.checked ? [...new Set([...ids, topMatch.id])] : ids.filter(id => id !== topMatch.id))}/>}<div><b>{extracted.merchantName || document.title}</b><span>{extracted.transactionDate || document.document_date || '날짜 확인 필요'} · {money(extracted.totalAmount)} · {document.review_status === 'change_requested' ? '수정 요청' : document.review_status === 'approved' ? '승인 완료' : '관리자 검토'}</span></div><div className="expense-review-actions"><button className="outline" onClick={() => openOriginal(document)}>원본 보기</button><button className="outline" onClick={() => toggleExpanded(document)}>{expanded ? '접기' : '검토하기'}</button></div></div>
        <div className="expense-match-summary"><span>카드 후보 <b>{document.matches?.length || 0}건</b></span>{topMatch ? <><span>{topMatch.transaction?.merchant_name || '사용처 미확인'} · {money(topMatch.transaction?.net_amount)}</span><em>{topMatch.score}점</em></> : <span>일치 후보 없음 · 직접 지출로 검토</span>}</div>
        {expanded && <div className="expense-review-detail">
          <div className="receipt-review-compare">{originalUrls[document.id] ? <img src={originalUrls[document.id]} alt={`${document.title} 원본 영수증`}/> : <div className="empty-inline">원본을 불러오는 중…</div>}<div><b>인식된 품목</b>{document.lineItems?.length ? <div className="receipt-review-lines">{document.lineItems.map(line => <span key={line.id}><span>{line.item_name_normalized || line.item_name_raw || `품목 ${line.line_number}`}{line.quantity ? ` · ${line.quantity}${line.unit || ''}` : ''}</span><strong>{money(line.line_amount)}</strong></span>)}</div> : <p>인식된 품목이 없습니다. 총액과 원본을 직접 확인해 주세요.</p>}</div></div>
          {expense && <form className="expense-review-form" onSubmit={event => save(event, { expense })}><label>사용처<input name="merchantName" defaultValue={expense.merchant_name || extracted.merchantName || ''}/></label><label>거래일<input name="transactionDate" type="date" required defaultValue={expense.transaction_date || extracted.transactionDate || ''}/></label><label>총금액<input name="totalAmount" type="number" min="0" required defaultValue={expense.total_amount || extracted.totalAmount || 0}/></label><label>사업자번호<input name="merchantBusinessNumber" defaultValue={expense.merchant_business_number || extracted.merchantBusinessNumber || ''}/></label><label>분류<select name="category" defaultValue={expense.category || ''}><option value="">분류 확인 필요</option><option value="재료비">재료비</option><option value="소모품비">소모품비</option><option value="교통비">교통비</option><option value="접대비">접대비</option><option value="공과금">공과금</option><option value="임차료">임차료</option><option value="기타">기타</option></select></label><label>지출 사유<input name="reason" defaultValue={expense.reason || ''} placeholder="예: 주방 식자재 구입"/></label><label className="expense-rule-check"><input name="rememberRule" type="checkbox"/><span>같은 가맹점은 다음부터 이 분류·사유 자동 적용</span></label><button className="outline" disabled={busyId === expense.id}>{busyId === expense.id ? '저장 중…' : 'OCR 정보 수정'}</button></form>}
          {!expense && document.review_status === 'submitter_review' && <form className="expense-review-form" onSubmit={event => saveDocument(event, document)}><label>사용처<input name="merchantName" required defaultValue={extracted.merchantName || ''}/></label><label>거래일<input name="transactionDate" type="date" required defaultValue={extracted.transactionDate || document.document_date || ''}/></label><label>총금액<input name="totalAmount" type="number" min="1" required defaultValue={extracted.totalAmount || ''}/></label><label>부서·섹션<select name="costCenterId" required defaultValue={document.cost_center_id || ''}><option value="">선택</option>{costCenters.map(center => <option key={center.id} value={center.id}>{center.name}</option>)}</select></label><label>결제수단<select name="paymentMethod" required defaultValue={document.payment_method || 'corporate_card'}><option value="corporate_card">법인카드</option><option value="personal_card">개인카드</option><option value="cash">현금</option><option value="bank_transfer">계좌이체</option><option value="other">기타</option></select></label><button className="outline" disabled={busyId === document.id}>{busyId === document.id ? '저장 중…' : '기본정보 저장 후 재분석'}</button></form>}
          <div className="expense-match-list">{document.matches?.length ? document.matches.map(match => <div className="expense-match-candidate" key={match.id}><div><b>{match.transaction?.card?.nickname || match.transaction?.card?.issuer || '법인카드'} •••• {match.transaction?.card?.last4}</b><span>{match.transaction?.merchant_name || '-'} · {money(match.transaction?.net_amount)} · {String(match.transaction?.approved_at || '').slice(0, 10)}</span><small>금액 {match.score_breakdown?.amount || 0} · 날짜 {match.score_breakdown?.date || 0} · 승인번호 {match.score_breakdown?.approvalNumber || 0} · 카드 {match.score_breakdown?.cardLast4 || 0}</small></div><em>{match.score}점</em><button className="outline" disabled={Boolean(busyId)} onClick={() => review(document, match, 'reject')}>반려</button><button className="submit" disabled={Boolean(busyId)} onClick={() => review(document, match, match.status === 'confirmed' ? 'unlink' : 'confirm')}>{match.status === 'confirmed' ? '연결 해제' : '이 거래로 확정'}</button></div>) : <div className="empty-inline">자동으로 찾은 카드 거래가 없습니다.</div>}</div>
          {canReview && <div className="receipt-review-decisions"><button className="outline danger-outline" disabled={Boolean(busyId) || topMatch?.status === 'confirmed'} onClick={() => exclude(document)}>지출에서 제외</button><button className="outline" disabled={Boolean(busyId)} onClick={() => requestChange(document)}>직원에게 수정 요청</button>{expense && topMatch?.status !== 'confirmed' && <button className="submit" disabled={Boolean(busyId)} onClick={() => approveWithoutCard(document, expense)}>카드 연결 없이 승인</button>}</div>}
        </div>}
      </article>;
    }) : <div className="empty-schedule"><b>확인할 영수증이 없어요.</b><span>새 영수증이 분석되거나 매칭 예외가 생기면 여기에 표시됩니다.</span></div>}
  </section>;
}
