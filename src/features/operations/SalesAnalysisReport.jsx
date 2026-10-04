import React, { useMemo, useState } from 'react';
import { changePercent } from '../../../shared/operations.js';

const number = value => Math.round(Number(value || 0)).toLocaleString('ko-KR');
const money = value => `${number(value)}원`;
const weekday = ['일', '월', '화', '수', '목', '금', '토'];
const weekdayLabel = date => weekday[new Date(`${date}T00:00:00Z`).getUTCDay()];

const comparison = (current, previous, unit = '원', comparable = true) => {
  if (!comparable) return { label: '비교 보류', amount: null, percent: null, trend: 'unavailable' };
  const amount = Number(current || 0) - Number(previous || 0);
  const percent = changePercent(Number(current || 0), Number(previous || 0));
  return {
    amount,
    percent,
    trend: amount > 0 ? 'up' : amount < 0 ? 'down' : 'flat',
    label: `${amount > 0 ? '+' : amount < 0 ? '−' : ''}${number(Math.abs(amount))}${unit}${percent === null ? '' : ` · ${Math.abs(percent).toFixed(1)}%`}`,
  };
};

function Trend({ value }) {
  return <span className={`sales-trend ${value.trend}`}><i aria-hidden="true">{value.trend === 'up' ? '↑' : value.trend === 'down' ? '↓' : value.trend === 'flat' ? '→' : '—'}</i>{value.label}</span>;
}

function Kpis({ data, compact }) {
  const items = [
    { key: 'revenue', label: '완료 매출', value: money(data.current.revenue), previous: money(data.previous.revenue), trend: comparison(data.current.revenue, data.previous.revenue, '원', data.comparable), hint: '취소 제외 완료 주문' },
    { key: 'orders', label: '완료 주문', value: `${number(data.current.orders)}건`, previous: `${number(data.previous.orders)}건`, trend: comparison(data.current.orders, data.previous.orders, '건', data.comparable), hint: '결제가 완료된 주문' },
    { key: 'average', label: '주문당 금액', value: data.current.average === null ? '—' : money(data.current.average), previous: data.previous.average === null ? '—' : money(data.previous.average), trend: comparison(data.current.average, data.previous.average, '원', data.comparable), hint: '완료 매출 ÷ 완료 주문' },
    { key: 'cancelled', label: '취소 주문', value: `${number(data.current.cancelled)}건`, previous: `${number(data.previous.cancelled)}건`, trend: comparison(data.current.cancelled, data.previous.cancelled, '건', data.comparable), hint: '원주문 취소 상태' },
  ].slice(0, compact ? 3 : 4);
  return <div className="sales-kpi-grid">{items.map(item => <article className={`sales-kpi ${item.key}`} key={item.key}><div><span>{item.label}</span><small>{item.hint}</small></div><strong>{item.value}</strong><Trend value={item.trend}/><em>직전 7일 {item.previous}</em></article>)}</div>;
}

function DataTrust({ data, statusLabel, time }) {
  const checks = [
    ['기간 수집', data.status?.coveredFrom && data.status?.coveredTo, data.status?.coveredFrom ? `${time(data.status.coveredFrom)} ~ ${time(data.status.coveredTo)}` : '수집 이력 없음'],
    ['페이지 완주', data.status?.pageComplete, data.status?.pageComplete ? '전체 페이지 확인' : '완주 이력 필요'],
    ['원주문 대조', data.status?.cacheMatched, data.status?.cacheMatched ? '원주문과 일 집계 일치' : '집계 대조 필요'],
  ];
  return <details className={`sales-trust ${data.comparable ? 'complete' : 'incomplete'}`} open={!data.comparable || Boolean(data.syncError)}><summary><span><i aria-hidden="true">{data.comparable ? '✓' : '!'}</i><b>{statusLabel}</b></span><em>마지막 수집 {time(data.status?.lastSyncedAt || data.syncedAt)}</em><small>상세 보기</small></summary><div>{checks.map(([label, passed, description]) => <p className={passed ? 'passed' : 'pending'} key={label}><i>{passed ? '✓' : '!'}</i><span><b>{label}</b><small>{description}</small></span></p>)}{data.status?.revisionCount > 0 && <p className="pending"><i>↻</i><span><b>정정 이력</b><small>{data.status.revisionCount}회 재집계</small></span></p>}</div></details>;
}

function InsightPanel({ data }) {
  const revenueDelta = Number(data.current.revenue) - Number(data.previous.revenue);
  const orderEffect = data.comparable ? (Number(data.current.orders) - Number(data.previous.orders)) * Number(data.previous.average || 0) : null;
  const ticketEffect = data.comparable ? Number(data.current.orders) * (Number(data.current.average || 0) - Number(data.previous.average || 0)) : null;
  const ranked = data.current.days.map((day, index) => ({ ...day, index, delta: day.revenue - data.previous.days[index].revenue })).sort((a, b) => b.revenue - a.revenue);
  const best = ranked[0];
  const weakest = [...ranked].sort((a, b) => a.delta - b.delta)[0];
  const direction = revenueDelta > 0 ? '증가' : revenueDelta < 0 ? '감소' : '유지';
  return <section className="sales-insight-panel"><div className="sales-insight-head"><div><span>선택 기간 핵심 해석</span><h3>{data.comparable ? `매출이 직전 7일보다 ${money(Math.abs(revenueDelta))} ${direction}했습니다.` : '비교 가능한 수집 이력이 더 필요합니다.'}</h3><p>{data.comparable ? `주문 수와 주문당 금액을 분리해 매출 변화 원인을 보여줍니다.` : '현재 값은 저장된 완료 주문 합계이며 증감 해석은 보류합니다.'}</p></div><strong className={revenueDelta >= 0 ? 'positive' : 'negative'}>{data.comparable ? `${revenueDelta >= 0 ? '+' : '−'}${Math.abs(changePercent(data.current.revenue, data.previous.revenue) || 0).toFixed(1)}%` : '—'}</strong></div><div className="sales-insight-factors"><article><span>주문 수 효과</span><strong>{orderEffect === null ? '—' : `${orderEffect >= 0 ? '+' : '−'}${money(Math.abs(orderEffect))}`}</strong><small>{data.comparable ? `${number(data.current.orders - data.previous.orders)}건 변화 × 직전 객단가` : '비교 보류'}</small></article><article><span>객단가 효과</span><strong>{ticketEffect === null ? '—' : `${ticketEffect >= 0 ? '+' : '−'}${money(Math.abs(ticketEffect))}`}</strong><small>{data.comparable ? `현재 주문에 객단가 변화 적용` : '비교 보류'}</small></article><article><span>최고 매출일</span><strong>{best ? `${weekdayLabel(best.date)}요일 · ${money(best.revenue)}` : '—'}</strong><small>{best ? `${number(best.orders)}건 · 객단가 ${best.average === null ? '—' : money(best.average)}` : '데이터 없음'}</small></article><article><span>우선 확인 요일</span><strong>{data.comparable && weakest ? `${weekdayLabel(weakest.date)}요일 · ${weakest.delta >= 0 ? '+' : '−'}${money(Math.abs(weakest.delta))}` : '—'}</strong><small>{data.comparable ? '직전 7일 대비 매출 변화가 가장 낮음' : '비교 보류'}</small></article></div></section>;
}

function DayDetail({ day, previous, comparable }) {
  const revenue = comparison(day.revenue, previous.revenue, '원', comparable);
  const previousLabel = value => comparable ? `직전 7일 ${value}` : '직전 7일 비교 보류';
  return <aside className="sales-selected-day"><div className="sales-selected-day-title"><span>{day.date} · {weekdayLabel(day.date)}요일</span><strong>{money(day.revenue)}</strong><Trend value={revenue}/></div><dl><div><dt>완료 주문</dt><dd>{number(day.orders)}건</dd><small>{previousLabel(`${number(previous.orders)}건`)}</small></div><div><dt>주문당 금액</dt><dd>{day.average === null ? '—' : money(day.average)}</dd><small>{previousLabel(previous.average === null ? '—' : money(previous.average))}</small></div><div><dt>취소 주문</dt><dd>{number(day.cancelled)}건</dd><small>{previousLabel(`${number(previous.cancelled)}건`)}</small></div><div><dt>데이터 상태</dt><dd>{day.covered ? '원주문 대조 완료' : '확인 필요'}</dd><small>{comparable ? '기간 수집까지 검증됨' : '기간 수집 이력 필요'}</small></div></dl></aside>;
}

function DailyAnalysis({ data }) {
  const [metric, setMetric] = useState('revenue');
  const [selected, setSelected] = useState(0);
  const value = day => metric === 'orders' ? Number(day.orders) : metric === 'average' ? Number(day.average || 0) : Number(day.revenue);
  const label = amount => metric === 'orders' ? `${number(amount)}건` : money(amount);
  const max = Math.max(1, ...data.current.days.map(value), ...(data.comparable ? data.previous.days.map(value) : []));
  return <section className="sales-daily-section"><div className="sales-section-head"><div><span>일별 흐름</span><h3>어느 날짜에서 차이가 생겼는지 확인하세요</h3><p>막대를 선택하면 매출·주문·객단가·취소를 함께 볼 수 있습니다.</p></div><div className="sales-metric-switch" aria-label="그래프 지표">{[['revenue','매출'],['orders','주문 수'],['average','주문당 금액']].map(([key, text]) => <button key={key} aria-pressed={metric === key} onClick={() => setMetric(key)}>{text}</button>)}</div></div><div className="sales-chart-legend"><span className="current">최근 7일</span>{data.comparable && <span className="previous">직전 7일</span>}<em>{data.comparable ? `그래프 최대값 ${label(max)}` : '직전 7일 비교는 수집 확인 후 표시'}</em></div><div className="sales-comparison-chart" role="img" aria-label="날짜별 최근 7일과 직전 7일 비교 그래프">{data.current.days.map((day, index) => { const previous = data.previous.days[index]; const trend = comparison(value(day), value(previous), metric === 'orders' ? '건' : '원', data.comparable); return <button type="button" className={selected === index ? 'selected' : ''} onClick={() => setSelected(index)} key={day.date}><span className="sales-chart-values"><b>{label(value(day))}</b>{data.comparable && <small>{trend.amount >= 0 ? '+' : '−'}{number(Math.abs(trend.amount))}{metric === 'orders' ? '건' : '원'}</small>}</span><span className="sales-chart-bars"><i className="current" style={{ height: `${Math.max(3, value(day) / max * 100)}%` }}/>{data.comparable && <i className="previous" style={{ height: `${Math.max(3, value(previous) / max * 100)}%` }}/>}</span><strong>{weekdayLabel(day.date)}<small>{day.date.slice(5)}</small></strong></button>; })}</div><DayDetail day={data.current.days[selected]} previous={data.previous.days[selected]} comparable={data.comparable}/><div className="sales-day-table"><div className="sales-day-table-head"><span>요일</span><span>완료 매출</span><span>직전 7일 대비</span><span>주문</span><span>객단가</span><span>취소</span></div>{data.current.days.map((day, index) => { const previous = data.previous.days[index]; const trend = comparison(day.revenue, previous.revenue, '원', data.comparable); return <button key={day.date} onClick={() => setSelected(index)}><span><b>{weekdayLabel(day.date)}요일</b><small>{day.date}</small></span><strong>{money(day.revenue)}</strong><Trend value={trend}/><span>{number(day.orders)}건</span><span>{day.average === null ? '—' : money(day.average)}</span><span>{number(day.cancelled)}건</span></button>; })}</div></section>;
}

function MenuAnalysis({ data }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('sales');
  const menus = useMemo(() => [...data.menus].filter(menu => `${menu.name} ${menu.category || ''}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => sort === 'quantity' ? b.quantity - a.quantity : sort === 'change' ? (b.quantity - (b.previous || 0)) - (a.quantity - (a.previous || 0)) : b.sales - a.sales), [data.menus, query, sort]);
  const leaders = menus.slice(0, 3);
  return <section className="sales-menu-section"><div className="sales-section-head"><div><span>메뉴 기여도</span><h3>매출을 만든 메뉴와 판매 변화를 확인하세요</h3><p>POS 메뉴 코드를 우선 사용하며 무료 옵션은 제외합니다.</p></div></div>{leaders.length > 0 && <div className="sales-menu-leaders">{leaders.map((menu, index) => <article key={menu.key}><span>{index + 1}</span><div><b>{menu.name}</b><small>{menu.category || '미분류'} · {number(menu.quantity)}개</small><i><em style={{ width: `${Math.min(100, menu.share)}%` }}/></i></div><strong>{money(menu.sales)}<small>{menu.share.toFixed(1)}%</small></strong></article>)}</div>}<div className="sales-menu-toolbar"><label><span>메뉴 검색</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="메뉴명 또는 카테고리 검색"/></label><label><span>정렬</span><select value={sort} onChange={event => setSort(event.target.value)}><option value="sales">판매액 높은 순</option><option value="quantity">판매 수량 높은 순</option><option value="change">직전 7일 증가 순</option></select></label></div>{!data.menuComparable && <p className="sales-inline-notice">메뉴 원문 또는 비교 기간 수집이 완전하지 않아 직전 7일 증감은 보류합니다.</p>}<div className="sales-menu-detail"><div className="sales-menu-detail-head"><span>순위·메뉴</span><span>판매 수량</span><span>주문 수</span><span>판매액</span><span>매출 비중</span><span>직전 7일 수량</span></div>{menus.map((menu, index) => <article key={menu.key}><span className="rank">{index + 1}</span><span className="name"><b>{menu.name}</b><small>{menu.category || '미분류'}{!menu.code ? ' · 이름 기준 집계' : ''}</small></span><strong>{number(menu.quantity)}개</strong><span>{number(menu.orders)}건</span><span>{money(menu.sales)}</span><span className="share"><i><em style={{ width: `${Math.min(100, menu.share)}%` }}/></i>{menu.share.toFixed(1)}%</span><span>{menu.previous === null ? '비교 보류' : `${number(menu.previous)}개 (${menu.quantity - menu.previous >= 0 ? '+' : ''}${number(menu.quantity - menu.previous)})`}</span></article>)}{!menus.length && <p className="ops-status">검색 조건에 맞는 메뉴가 없습니다.</p>}</div></section>;
}

export default function SalesAnalysisReport({ data, detailed, statusLabel, time, onOpenDetail }) {
  const [tab, setTab] = useState('daily');
  if (!detailed) return <><Kpis data={data} compact/><div className="sales-home-footer"><span>{data.comparable ? '직전 7일 비교가 완료되었습니다.' : '수집 확인 후 직전 7일 비교를 제공합니다.'}</span><button className="outline" onClick={onOpenDetail}>매출 분석 자세히 보기 →</button></div></>;
  return <><DataTrust data={data} statusLabel={statusLabel} time={time}/>{!data.comparable && <p className="sales-inline-notice warning">선택 기간과 직전 7일의 전체 페이지 수집 이력이 없어 증감 해석을 보류했습니다. 표시 금액은 현재 저장된 완료 주문 합계입니다.</p>}<Kpis data={data}/><InsightPanel data={data}/><nav className="sales-report-tabs" aria-label="매출 분석 상세"><button aria-current={tab === 'daily' ? 'page' : undefined} onClick={() => setTab('daily')}><b>일별 흐름</b><small>날짜별 매출·주문·객단가</small></button><button aria-current={tab === 'menus' ? 'page' : undefined} onClick={() => setTab('menus')}><b>메뉴 기여도</b><small>판매액·수량·매출 비중</small></button></nav>{tab === 'daily' ? <DailyAnalysis data={data}/> : <MenuAnalysis data={data}/>}<p className="sales-footnote">완료 주문 기준이며 실시간 매출 또는 순이익이 아닙니다. POS 수집 지연·취소 정정이 있으면 재집계될 수 있습니다.</p></>;
}
