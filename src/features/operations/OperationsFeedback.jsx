import React, { useEffect, useMemo, useState } from 'react';
import { addDays, attendanceIssues, kstDate, recentCompletedWeek, validAttendanceCorrection } from '../../../shared/operations.js';
import { correctAttendance, loadOperations } from './operationsApi';
import { readViewCache, writeViewCache } from '../../lib/viewCache';
import SalesAnalysisReport from './SalesAnalysisReport';

const number = value => Math.round(value).toLocaleString('ko-KR');
const money = value => `${number(value)}원`;
const time = value => value ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '기록 없음';
const issueLabels = { checkout: '퇴근 기록 누락', absent: '예정 근무의 출근 기록 없음', schedule: '근무 일정과 기록 불일치' };
function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(timer); }, []);
  return now;
}
function useOperations(organizationId, scope, filters, enabled = true, refreshToken = 0, accountId) {
  const key = JSON.stringify(filters);
  const identity = `${accountId}:${organizationId}:${scope}:${key}:${enabled}`;
  const cacheKey = enabled && accountId && organizationId ? `operations:${accountId}:${organizationId}:${scope}:${key}` : null;
  const [state, setState] = useState(() => {
    const data = readViewCache(cacheKey);
    return { data, loading: enabled && !data, error: '', identity };
  });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) { setState({ data: null, loading: false, error: '' }); return; }
    const cached = readViewCache(cacheKey);
    if (cached && !revision && !refreshToken) { setState({ data: cached, loading: false, error: '', identity }); return; }
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); setState(previous => ({ data: previous.identity === identity ? previous.data : null, loading: false, error: '조회 시간이 초과됐습니다. 다시 시도해 주세요.', identity })); }, 30000);
    setState(previous => ({ data: previous.identity === identity ? previous.data : cached, loading: !(previous.identity === identity ? previous.data : cached), error: '', identity }));
    loadOperations(organizationId, scope, JSON.parse(key), controller.signal).then(data => {
      clearTimeout(timeout);
      if (!controller.signal.aborted) { writeViewCache(cacheKey, data); setState({ data, loading: false, error: '', identity }); }
    }).catch(error => { clearTimeout(timeout); if (!controller.signal.aborted) setState(previous => ({ data: previous.identity === identity ? previous.data : null, loading: false, error: error.message, identity })); });
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [organizationId, scope, key, enabled, revision, refreshToken, cacheKey]);
  return { ...(state.identity === identity ? state : { data: null, loading: enabled, error: '' }), refresh: () => setRevision(value => value + 1) };
}
function LoadState({ resource, label }) {
  return resource.loading ? <p className="ops-status" role="status">{label} 불러오는 중…{resource.data ? ' 마지막 조회분을 표시합니다.' : ''}</p> : resource.error ? <div className="ops-status ops-error" role="alert"><span>{resource.error}{resource.data ? ' 아래는 마지막 정상 조회분입니다.' : ''}</span><button className="outline" onClick={resource.refresh}>다시 시도</button></div> : null;
}
function Task({ title, value, description, onClick }) {
  return <button className="ops-task" onClick={onClick}><span><b>{title}</b><small>{description}</small></span><strong>{value}</strong><span aria-hidden="true">›</span></button>;
}

export function OperationsHome({ employees, leaves, organizationId, accountId, isOwner, canAttendance, canLeave, onNavigate, dataError }) {
  const now = useNow(), today = kstDate(now), month = today.slice(0, 7);
  const from = `${month}-01`, to = addDays(today, -1);
  const issues = useMemo(() => attendanceIssues(employees, { from, to, now, leaves }), [employees, from, to, now, leaves]);
  const finance = useOperations(organizationId, 'tasks', { month }, isOwner, 0, accountId);
  const count = type => issues.filter(issue => issue.types.includes(type)).length;
  const openIssues = type => onNavigate('attendance', { issueType: type, from, to });
  const pending = leaves.filter(row => row.status === '승인 대기');
  const otherAttendanceCount = issues.filter(issue => issue.types.some(type => type !== 'checkout')).length;
  const hasFinanceTasks = Boolean(finance.data && (finance.data.attendanceChanged || finance.data.cardCount > 0));
  const hasTasks = (canAttendance && !dataError && issues.length > 0) || (canLeave && !dataError && pending.length > 0) || hasFinanceTasks;
  return <div className={`ops-workspace ${isOwner ? 'ops-home-grid' : ''}`}>
    <section className="card ops-card ops-action-queue"><div className="ops-heading"><div><p className="ops-eyebrow">오늘의 작업</p><h2>처리할 일</h2><p>{month} · 영향이 있는 항목부터 정리했습니다.</p></div><span className={`ops-tag ${hasTasks ? 'attention' : 'complete'}`}>{hasTasks ? '확인 필요' : '처리 완료'}</span></div>
      {dataError && <p className="ops-warning" role="alert">근태·휴가 데이터를 갱신하지 못해 확인 건수를 표시하지 않습니다. 화면 상단에서 다시 시도해 주세요.</p>}{canAttendance && !dataError && <>{count('checkout') > 0 && <Task title="퇴근 기록 누락" value={`${count('checkout')}건`} description="근무가 끝난 기록의 퇴근 시각을 확인해 주세요." onClick={() => openIssues('checkout')}/ >}{otherAttendanceCount > 0 && <details className="ops-more"><summary>다른 근태 확인 항목 · {otherAttendanceCount}개 기록</summary>{count('absent') > 0 && <Task title="예정 근무의 출근 기록 없음" value={`${count('absent')}건`} description="승인된 근무 일정과 실제 출근을 대조합니다." onClick={() => openIssues('absent')}/ >}{count('schedule') > 0 && <Task title="근무 일정과 기록 불일치" value={`${count('schedule')}건`} description="승인된 근무가 없거나 휴무일에 출근 기록이 있습니다." onClick={() => openIssues('schedule')}/ >}<p className="ops-note">같은 기록이 여러 항목에 포함될 수 있습니다. 결근·추가 근무로 확정한 수치가 아닙니다.</p></details>}</>}
      {isOwner && <><LoadState resource={finance} label="급여·카드 현황"/>{finance.data && <>{finance.data.attendanceChanged && <Task title={`${month} 급여 초안`} value="재검토" description={`${time(finance.data.draft.updated_at)} 저장 · 이후 변경된 근태를 확인하고 초안을 다시 검토해 주세요.`} onClick={() => onNavigate('payroll', { month })}/ >}{finance.data.cardCount > 0 && <Task title="미검토 카드 내역" value={`${finance.data.cardCount}건`} description={`${month} · ${money(finance.data.cardAmount)} · 확정 지출에 포함되지 않은 검토 대상`} onClick={() => onNavigate('documents', { cardReview: true, month })}/ >}</>}</>}
      {canLeave && !dataError && pending.length > 0 && <Task title="휴가 승인 대기" value={`${pending.length}건`} description="직원이 제출한 요청을 확인해 주세요." onClick={() => onNavigate('leave')}/>}
      {!hasTasks && !dataError && (canAttendance || canLeave || isOwner) && (!isOwner || (!finance.loading && !finance.error)) && <p className="ops-status">현재 확인할 항목이 없습니다.</p>}
      {!canAttendance && !canLeave && !isOwner && <p className="ops-status">조회 권한이 있는 메뉴에서 업무를 확인해 주세요.</p>}
    </section>
    {isOwner && <WeeklyFeedback organizationId={organizationId} accountId={accountId} onNavigate={onNavigate}/>}
  </div>;
}

export function WeeklyFeedback({ organizationId, accountId, detailed = false, initialFrom, onNavigate, refreshToken, onSync, syncing = false, syncMessage = '' }) {
  const today = kstDate(useNow()), latest = recentCompletedWeek(today);
  const [selectedFrom, setSelectedFrom] = useState(initialFrom || latest.from);
  const from = detailed ? selectedFrom : latest.from;
  const resource = useOperations(organizationId, 'weekly', { from }, true, refreshToken, accountId);
  const data = resource.data;
  const statusLabel = !data ? '확인 중' : data.status?.state === 'finalized' ? '마감 완료' : data.status?.state === 'revised' ? '재집계됨' : data.syncError ? '수집 오류' : '수집 확인 필요';
  return <section className={`card ops-card ops-weekly ${detailed ? 'sales-report' : 'sales-home-summary'}`}>
    <div className="ops-heading sales-analysis-heading">
      <div><p className="ops-eyebrow">{detailed ? 'POS 완료 주문 · 직전 7일 동일 요일 비교' : '어제까지 최근 7일'}</p><h2>{detailed ? '7일 매출 성과' : '매출 흐름'}</h2><p>{from} ~ {addDays(from, 6)} <span>비교 {addDays(from, -7)} ~ {addDays(from, -1)}</span></p></div>
      <span className={`sales-status ${data?.status?.state || 'loading'}`}>{statusLabel}</span>
    </div>
    {detailed && <div className="sales-period-toolbar"><div><button className="outline" onClick={() => setSelectedFrom(addDays(from, -7))}>← 이전 7일</button><button className="outline" disabled={from >= latest.from} onClick={() => setSelectedFrom(addDays(from, 7))}>다음 7일 →</button><button className="outline" disabled={from === latest.from} onClick={() => setSelectedFrom(latest.from)}>최근 7일</button></div><div>{onSync && <button className="submit" disabled={syncing || resource.loading} onClick={() => onSync({ from: addDays(from, -7), to: addDays(from, 6) })}>{syncing ? '매출 동기화 중…' : '최신 매출 동기화'}</button>}<button className="outline" disabled={resource.loading || syncing} onClick={resource.refresh}>다시 조회</button></div></div>}
    {syncMessage && <p className="ops-warning" role="status">{syncMessage}</p>}
    <LoadState resource={resource} label="주간 매출"/>
    {data && (!data.connected ? <p className="ops-status">연결된 매출 데이터가 없습니다. 운영 설정에서 POS 연결을 확인해 주세요.</p> : <SalesAnalysisReport data={data} detailed={detailed} statusLabel={statusLabel} time={time} onOpenDetail={() => onNavigate('sales', { from })}/>)}
  </section>;
}
export function AttendanceIssueList({ employees, leaves, organizationId, context, canCorrect, onRefresh, onBack, onOpenSchedule }) {
  const now = useNow();
  const [type, setType] = useState(context.issueType);
  const [selected, setSelected] = useState(null);
  const [page, setPage] = useState(context.page || 0);
  const [notice, setNotice] = useState('');
  const issues = attendanceIssues(employees, { from: context.from, to: context.to, now, leaves });
  const rows = issues.filter(issue => issue.types.includes(type));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 10) - 1));
  return <div className="ops-workspace"><button className="ops-back" onClick={onBack}>← {context.returnTo?.id === 'payroll' ? '급여 관리로' : '홈으로'}</button><section className="card ops-card"><div className="ops-heading"><div><p className="ops-eyebrow">근태 확인</p><h1>{issueLabels[type]}</h1><p>{context.from} ~ {context.to} · {rows.length}건</p></div><button className="outline" onClick={async () => { try { await onRefresh(); setNotice('최신 기록을 불러왔습니다.'); } catch { setNotice('새로고침하지 못했습니다. 이전 기록을 표시합니다.'); } }}>새로고침</button></div><div className="ops-tabs">{Object.entries(issueLabels).map(([key, label]) => <button aria-pressed={type === key} onClick={() => { setType(key); setPage(0); setSelected(null); }} key={key}>{label} ({issues.filter(issue => issue.types.includes(key)).length})</button>)}</div><p className="ops-note">조회만으로 항목이 사라지지 않습니다. 실제 출퇴근 또는 승인된 스케줄이 수정되면 다시 계산합니다.</p>{notice && <p role="status" className="ops-warning">{notice}</p>}{selected ? <AttendanceCorrection key={selected.key} issue={selected} organizationId={organizationId} canCorrect={canCorrect} onOpenSchedule={() => onOpenSchedule?.(selected, { issueType: type, page: currentPage })} onClose={() => setSelected(null)} onSaved={async () => { setNotice('정정 기록을 저장했습니다.'); setSelected(null); try { await onRefresh(); } catch { setNotice('저장은 완료됐지만 목록 갱신에 실패했습니다. 새로고침해 주세요.'); } }}/>: <>{rows.slice(currentPage * 10, currentPage * 10 + 10).map(issue => <button className="ops-task" key={issue.key} onClick={() => setSelected(issue)}><span><b>{issue.employee.name} · {issue.date}</b><small>{issue.employee.team} · 출근 {time(issue.record?.checked_in_at)} · 퇴근 {time(issue.record?.checked_out_at)}</small><small>{issue.schedule?.is_day_off ? '승인 일정: 휴무' : issue.schedule ? `예정 ${issue.schedule.starts_at?.slice(0, 5)}–${issue.schedule.ends_at?.slice(0, 5)}` : '승인된 근무 일정 없음'}</small></span><strong>기록 확인 ›</strong></button>)}{!rows.length && <p className="ops-status">이 기간에 해당하는 확인 항목이 없습니다.</p>}{rows.length > 10 && <div className="ops-controls"><button className="outline" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>이전</button><span>{currentPage + 1} / {Math.ceil(rows.length / 10)}</span><button className="outline" disabled={(currentPage + 1) * 10 >= rows.length} onClick={() => setPage(currentPage + 1)}>다음</button></div>}</>}</section></div>;
}
function AttendanceCorrection({ issue, organizationId, canCorrect, onClose, onSaved, onOpenSchedule }) {
  const local = value => value ? new Date(Date.parse(value) + 9 * 3600000).toISOString().slice(0, 19) : '';
  const [checkedIn, setCheckedIn] = useState(local(issue.record?.checked_in_at));
  const [checkedOut, setCheckedOut] = useState(local(issue.record?.checked_out_at));
  const [reason, setReason] = useState(''), [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const save = async event => {
    event.preventDefault(); setError('');
    if (!validAttendanceCorrection({ date: issue.date, checkedIn, checkedOut, reason, requireCheckout: issue.types.includes('checkout') })) { setError('출근 날짜, 퇴근 시각, 정정 사유를 확인해 주세요.'); return; }
    if (!confirm) { setConfirm(true); return; }
    setBusy(true);
    try { await correctAttendance({ organizationId, issue, checkedIn, checkedOut, reason }); await onSaved(); }
    catch (next) { setError(next.message || '정정 기록을 저장하지 못했습니다.'); setConfirm(false); }
    finally { setBusy(false); }
  };
  return <div className="ops-correction"><button className="ops-back" disabled={busy} onClick={onClose}>← 확인 목록</button><h2>{issue.employee.name} · {issue.date}</h2><p>기존 출근 {time(issue.record?.checked_in_at)} / 퇴근 {time(issue.record?.checked_out_at)}</p>{issue.types.includes('schedule') && <p className="ops-warning">출퇴근 시각이 맞다면 스케줄 관리에서 해당 날짜의 근무를 확인하세요. 기록 정정만으로 일정 불일치가 해소되지는 않습니다.{canCorrect && onOpenSchedule && <button type="button" className="outline" disabled={busy} onClick={onOpenSchedule}>이 날짜 스케줄 확인</button>}</p>}{canCorrect ? <form onSubmit={save}><fieldset disabled={busy || confirm}><label>출근 시각 (한국 시간)<input type="datetime-local" step="1" required value={checkedIn} onChange={event => setCheckedIn(event.target.value)}/></label><label>퇴근 시각 (한국 시간)<input type="datetime-local" step="1" required={issue.types.includes('checkout')} value={checkedOut} onChange={event => setCheckedOut(event.target.value)}/></label><label>정정 사유<textarea required minLength={2} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} placeholder="실제 근무 사실을 확인한 근거를 남겨 주세요."/></label></fieldset>{confirm && <p className="ops-warning">위 시각으로 실제 근태를 정정합니다. 기존 값과 정정 사유가 이력에 남으며, 급여 초안은 별도로 다시 검토해야 합니다.</p>}{error && <p role="alert" className="ops-error">{error}</p>}<div className="ops-controls">{confirm && <button type="button" className="outline" disabled={busy} onClick={() => setConfirm(false)}>다시 수정</button>}<button className="submit" disabled={busy}>{busy ? '저장 중…' : confirm ? '정정 내용 저장' : '정정 내용 확인'}</button></div></form> : <p className="ops-note">조회 권한으로 열었습니다. 정정은 최고관리자에게 요청해 주세요.</p>}</div>;
}

export function CardReviewList({ organizationId, accountId, month, onBack, onOpenReviewQueue }) {
  const resource = useOperations(organizationId, 'cards', { month }, true, 0, accountId);
  const [page, setPage] = useState(0), [expanded, setExpanded] = useState(null);
  const rows = resource.data?.cards || [];
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 10) - 1));
  return <div className="ops-workspace"><button className="ops-back" onClick={onBack}>← 홈으로</button><section className="card ops-card"><div className="ops-heading"><div><p className="ops-eyebrow">지출 · 증빙</p><h1>미검토 카드 내역</h1><p>{month} · 승인·취소를 합친 거래 단위</p></div><button className="outline" disabled={resource.loading} onClick={resource.refresh}>새로고침</button></div><LoadState resource={resource} label="미검토 카드"/>{resource.data && <><p className="ops-warning">{rows.length}건 · {money(rows.reduce((sum, row) => sum + Number(row.net_amount), 0))} — 검토 전 카드 사용액이며 확정 지출이 아닙니다.</p>{rows.slice(currentPage * 10, currentPage * 10 + 10).map(row => <div key={row.id}><button className="ops-task" aria-expanded={expanded === row.id} onClick={() => setExpanded(expanded === row.id ? null : row.id)}><span><b>{row.merchant_name || '사용처 미등록'}</b><small>{time(row.approved_at)} · {row.card?.nickname || '카드'} ••••{row.card?.last4}</small></span><strong>{money(row.net_amount)}</strong><span aria-hidden="true">⌄</span></button>{expanded === row.id && <div className="ops-card-detail"><b>증빙 대조가 필요합니다</b><p>아래 증빙 관리에서 영수증을 등록한 뒤 카드 후보와 대조·확정해 주세요. 상세 조회만으로 검토가 완료되지는 않습니다.</p><button className="outline" onClick={() => onOpenReviewQueue?.()}>증빙 검토함으로 이동</button></div>}</div>)}{!rows.length && <p className="ops-status">이 달의 미검토 카드 내역이 없습니다.</p>}{rows.length > 10 && <div className="ops-controls"><button className="outline" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>이전</button><span>{currentPage + 1} / {Math.ceil(rows.length / 10)}</span><button className="outline" disabled={(currentPage + 1) * 10 >= rows.length} onClick={() => setPage(currentPage + 1)}>다음</button></div>}</>}</section></div>;
}
