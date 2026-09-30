import React, { useEffect, useState } from 'react';
import { loadExpenseExceptions } from '../../lib/supabase';

const labels = { all: '전체', missing_receipt: '미증빙 카드', receipt_review: '영수증 검토', ocr_failed: 'OCR 실패', card_connection: '카드 연결', closeout_draft: '결산' };
const targetSelector = { cards: '.corporate-card-workspace', connections: '.corporate-card-workspace', receipts: '.expense-review-queue', closeouts: '.finance-report-dashboard' };

export default function ExpenseExceptionInbox({ organizationId, onNavigate, refreshToken = 0 }) {
  const [data, setData] = useState({ items: [], summary: {} }); const [filter, setFilter] = useState('all'); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const refresh = async () => { if (!organizationId) return; setLoading(true); setError(''); try { setData(await loadExpenseExceptions(organizationId)); } catch (nextError) { setError(nextError.message || '예외 업무함을 불러오지 못했습니다.'); } finally { setLoading(false); } };
  useEffect(() => { refresh(); }, [organizationId]);
  useEffect(() => { if (refreshToken > 0) refresh(); }, [refreshToken]);
  const items = filter === 'all' ? data.items : data.items.filter(item => item.type === filter);
  const move = item => { if (onNavigate) { onNavigate(item); return; } const target = document.querySelector(targetSelector[item.target]); target?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  return <section className="card full-card expense-exception-inbox">
    <div className="card-title"><div><h2>지출 예외 업무함</h2><p>정상 처리된 항목은 숨기고 관리자 조치가 필요한 건만 우선순위로 표시합니다.</p></div><button className="outline" disabled={loading} onClick={refresh}>{loading ? '확인 중…' : '새로고침'}</button></div>
    <div className="exception-summary"><div className="critical"><span>긴급</span><b>{data.summary.critical || 0}</b></div><div><span>주의</span><b>{data.summary.warning || 0}</b></div><div><span>미증빙 카드</span><b>{data.summary.missingReceipts || 0}</b></div><div><span>영수증 확인</span><b>{data.summary.receiptReviews || 0}</b></div><div><span>연결 장애</span><b>{data.summary.connectionIssues || 0}</b></div></div>
    <div className="exception-filters">{Object.entries(labels).map(([value,label]) => <button className={filter === value ? 'active' : ''} key={value} onClick={() => setFilter(value)}>{label}</button>)}</div>
    {error ? <div className="connection-error"><span>{error}</span><button onClick={refresh}>다시 시도</button></div> : loading ? <div className="empty-inline">예외 항목을 분류하는 중…</div> : items.length ? <div className="exception-list">{items.slice(0, 50).map(item => <article key={item.id}><i className={item.severity}/><div><b>{item.title}</b><span>{item.description}</span><small>{item.owner} 담당 · {item.ageDays ? `${item.ageDays}일 경과` : '오늘 발생'}</small></div><em>{item.severity === 'critical' ? '긴급' : item.severity === 'warning' ? '주의' : '확인'}</em><button className="outline" onClick={() => move(item)}>처리 위치로 이동</button></article>)}</div> : <div className="exception-empty"><b>처리할 예외가 없어요</b><span>카드 수집, 영수증 매칭, 결산 상태가 정상입니다.</span></div>}
  </section>;
}
