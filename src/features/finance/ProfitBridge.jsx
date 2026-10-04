import React, { useState } from 'react';
import { buildProfitBridge } from './profitBridgeModel';
import { financeCostOverview } from './financeCostOverview';

const won = value => new Intl.NumberFormat('ko-KR', { style: 'currency', currency: 'KRW', maximumFractionDigits: 0 }).format(Math.round(Number(value) || 0));

export default function ProfitBridge({ report }) {
  const [view, setView] = useState('forecast');
  const isForecast = Boolean(report.hasForecast && view === 'forecast');
  const totals = isForecast ? report.totals : report.actualTotals || report.totals;
  const bridge = buildProfitBridge(totals);
  const width = value => `${Math.min(100, Math.max(0, Math.abs(value) / bridge.scale * 100))}%`;
  return <section className="finance-profit-bridge" aria-label="손익 브리지 차트">
    <div className="finance-profit-bridge-title"><div><h3>매출에서 순익까지</h3><p>순매출에서 운영지출과 인건비를 차감한 흐름을 보여줍니다. 카드 미증빙 지출은 잠정 포함됩니다.</p></div>{report.hasForecast && <div className="finance-profit-bridge-switch" role="group" aria-label="손익 기준 선택"><button type="button" className={!isForecast ? 'active' : ''} aria-pressed={!isForecast} onClick={() => setView('actual')}>현재 실적</button><button type="button" className={isForecast ? 'active' : ''} aria-pressed={isForecast} onClick={() => setView('forecast')}>기간 말 예상</button></div>}</div>
    <div className="finance-profit-bridge-flow">{bridge.steps.map(step => {
      const isCost = step.key === 'expenses' || step.key === 'labor';
      const start = isCost ? Math.max(0, step.remaining) : 0;
      return <div className={`finance-profit-bridge-row ${step.key}${isForecast ? ' forecast' : ''}`} key={step.key}>
        <span className="label">{step.label}</span><div className="track"><i className="bar" style={{ left: width(start), width: width(step.value) }}/>{isCost && <span className="remaining">차감 후 {won(step.remaining)}</span>}</div><strong className={step.value < 0 ? 'negative' : ''}>{isCost ? '− ' : ''}{won(step.value)}</strong>
      </div>;
    })}</div>
    <div className="finance-profit-bridge-rates" aria-label="매출 대비 비용률">{financeCostOverview(totals, report.actualTotals || totals).map(item => <div key={item.key}><span>{item.label} 코스트</span><b>{item.rate === null ? '-' : `${(item.rate * 100).toFixed(1)}%`}</b><small>{item.basis}</small></div>)}</div>
    <p className="finance-profit-bridge-foot">{isForecast ? `예상 · ${report.to} 기준` : `실적 · ${report.asOfDate || report.to}까지`} · 운영지출 {won(bridge.expenses)} + 인건비 {won(bridge.labor)} 차감 · 순익률 {bridge.sales > 0 ? `${(bridge.profit / bridge.sales * 100).toFixed(1)}%` : '-'} · 재고 실사용 원가 및 홀·주방 인건비 구분은 미연동</p>
  </section>;
}
