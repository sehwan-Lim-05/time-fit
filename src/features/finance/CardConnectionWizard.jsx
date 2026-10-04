import React, { useEffect, useState } from 'react';
import {
  createCardConnection,
  discoverCardConnectionAssets,
  getAuthContext,
  loadCardConnectionHistory,
  loadCardConnections,
  reauthenticateCardConnection,
  selectCardConnectionAssets,
  syncCardConnection,
} from '../../lib/supabase';

const statusLabel = status => ({
  authenticating: '인증 확인 중',
  backfilling: '최초 내역 수집 중',
  active: '자동 연결 정상',
  degraded: '연결 확인 필요',
  reauth_required: '재인증 필요',
  paused: '수집 일시 정지',
}[status] || '연결 준비');

export default function CardConnectionWizard() {
  const [organizationId, setOrganizationId] = useState('');
  const [isOwner, setIsOwner] = useState(false);
  const [connections, setConnections] = useState([]);
  const [connection, setConnection] = useState(null);
  const [assets, setAssets] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [businessType, setBusinessType] = useState('corporation');
  const [consented, setConsented] = useState(false);
  const [step, setStep] = useState('consent');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  const [reauthForm, setReauthForm] = useState({ cardCompanyCode: '', businessNumber: '', loginMethod: 'id_password', loginId: '', password: '' });
  const provider = process.env.NEXT_PUBLIC_CARD_CONNECTION_PROVIDER || 'mock';

  useEffect(() => {
    let active = true;
    getAuthContext().then(async context => {
      if (!active) return;
      const nextOrganizationId = context.membership?.organization_id || '';
      setOrganizationId(nextOrganizationId);
      setIsOwner(Boolean(context.isOrganizationOwner));
      if (!nextOrganizationId) return;
      const items = await loadCardConnections(nextOrganizationId);
      if (!active) return;
      setConnections(items);
      const current = items.find(item => ['active', 'backfilling', 'degraded', 'reauth_required', 'authenticating'].includes(item.status));
      if (current) {
        setConnection(current); setStep(['active', 'degraded', 'reauth_required'].includes(current.status) ? 'complete' : 'cards');
        loadCardConnectionHistory({ organizationId: nextOrganizationId, connectionId: current.id }).then(value => active && setHistory(value)).catch(() => {});
      }
    }).catch(nextError => active && setError(nextError.message || '카드 연결 상태를 확인하지 못했습니다.'));
    return () => { active = false; };
  }, []);

  const startConnection = async () => {
    if (!consented) return setError('필수 수집·이용 동의 내용을 확인해 주세요.');
    setBusy(true); setError('');
    try {
      const created = await createCardConnection({ organizationId, provider, businessType });
      const discovered = await discoverCardConnectionAssets({ organizationId, connectionId: created.id });
      setConnection(created); setConnections(items => [created, ...items]); setAssets(discovered);
      setSelectedIds(discovered.map(item => item.id)); setStep('cards');
    } catch (nextError) { setError(nextError.message || '카드사 연결을 시작하지 못했습니다.'); }
    finally { setBusy(false); }
  };

  const loadAssets = async () => {
    if (!connection) return;
    setBusy(true); setError('');
    try {
      const discovered = await discoverCardConnectionAssets({ organizationId, connectionId: connection.id });
      setAssets(discovered); setSelectedIds(discovered.filter(item => item.status === 'selected').map(item => item.id));
    } catch (nextError) { setError(nextError.message || '보유카드를 조회하지 못했습니다.'); }
    finally { setBusy(false); }
  };

  const connectSelectedCards = async () => {
    if (!selectedIds.length) return setError('자동 수집할 카드를 한 장 이상 선택해 주세요.');
    setBusy(true); setError(''); setStep('syncing');
    try {
      await selectCardConnectionAssets({ organizationId, connectionId: connection.id, assetIds: selectedIds });
      const response = await syncCardConnection({ organizationId, connectionId: connection.id, mode: 'backfill' });
      setResult(response.result || { imported: response.run?.inserted_count || 0, duplicates: response.run?.duplicate_count || 0, groups: 0 });
      setStep('complete');
      window.dispatchEvent(new CustomEvent('timefit-card-sync-complete'));
    } catch (nextError) { setError(nextError.message || '최초 카드 내역을 가져오지 못했습니다.'); setStep('cards'); }
    finally { setBusy(false); }
  };

  const retrySync = async () => {
    if (!connection) return;
    setBusy(true); setError('');
    try {
      const response = await syncCardConnection({ organizationId, connectionId: connection.id, mode: 'incremental' });
      setResult(response.result || null);
      setConnection(item => ({ ...item, status: 'active', last_error_code: null, last_error_category: null, next_sync_at: null }));
      setConnections(items => items.map(item => item.id === connection.id ? { ...item, status: 'active', last_error_code: null, last_error_category: null } : item));
      window.dispatchEvent(new CustomEvent('timefit-card-sync-complete'));
    } catch (nextError) { setError(nextError.message || '카드 내역을 다시 가져오지 못했습니다.'); }
    finally { setBusy(false); }
  };

  const submitReauthentication = async () => {
    if (!connection) return;
    if (!reauthForm.cardCompanyCode.trim() || !reauthForm.businessNumber.replace(/\D/g, '') || !reauthForm.loginMethod) return setError('카드사 코드, 사업자번호와 인증 방식을 입력해 주세요.');
    setBusy(true); setError('');
    try {
      const updated = await reauthenticateCardConnection({ organizationId, connectionId: connection.id, authentication: { ...reauthForm, businessNumber: reauthForm.businessNumber.replace(/\D/g, '') } });
      setConnection(updated); setConnections(items => items.map(item => item.id === updated.id ? updated : item));
      setReauthForm({ cardCompanyCode: '', businessNumber: '', loginMethod: 'id_password', loginId: '', password: '' });
      setHistory(await loadCardConnectionHistory({ organizationId, connectionId: updated.id }));
      setStep('complete'); setResult(null);
    } catch (nextError) { setError(nextError.message || '카드사 재인증을 완료하지 못했습니다.'); }
    finally { setBusy(false); }
  };

  if (!isOwner) return <div className="connection-wizard denied"><b>소유자 확인이 필요해요</b><span>카드사 인증과 카드 선택은 사업장 소유자만 진행할 수 있습니다.</span></div>;

  return <div className="connection-wizard">
    <div className="connection-wizard-head"><div><b>{provider === 'mock' ? '카드 연결 테스트' : '실제 카드사 연결'}</b><span>{provider === 'mock' ? '테스트 데이터만 사용하며 실제 카드사에는 연결되지 않습니다.' : 'Hyphen 카드사 연결'}</span></div><em>{step === 'consent' ? '1/3 동의' : step === 'cards' ? '2/3 카드 선택' : step === 'syncing' ? '3/3 최초 수집' : '연결 완료'}</em></div>
    {connections.length > 0 && <div className="connection-status-list">{connections.slice(0, 2).map(item => <span key={item.id}><i className={item.status}/>{item.provider} · {statusLabel(item.status)}{item.last_succeeded_at ? ` · ${new Date(item.last_succeeded_at).toLocaleString('ko-KR')}` : ''}</span>)}</div>}
    {step === 'consent' && <div className="connection-consent"><label>사업자 유형<select value={businessType} onChange={event => setBusinessType(event.target.value)}><option value="corporation">법인사업자</option><option value="sole_proprietor">개인사업자</option></select></label><label className="connection-check"><input type="checkbox" checked={consented} onChange={event => setConsented(event.target.checked)}/><span><b>카드 사용내역 수집·이용에 동의합니다. (필수)</b><small>승인·취소·매입 내역과 카드 끝 4자리만 저장하며 카드번호 전체와 CVC는 저장하지 않습니다.</small></span></label><button className="submit" disabled={busy || !organizationId || !consented} onClick={startConnection}>{busy ? '카드사 확인 중…' : '동의하고 보유카드 조회'}</button></div>}
    {step === 'cards' && <div className="connection-assets"><div className="connection-assets-title"><b>자동 수집할 카드 선택</b><button className="outline" disabled={busy} onClick={loadAssets}>{busy ? '조회 중…' : assets.length ? '다시 조회' : '보유카드 조회'}</button></div>{assets.length ? assets.map(asset => <label key={asset.id} className="connection-asset"><input type="checkbox" checked={selectedIds.includes(asset.id)} onChange={event => setSelectedIds(ids => event.target.checked ? [...new Set([...ids, asset.id])] : ids.filter(id => id !== asset.id))}/><span><b>{asset.display_name}</b><small>•••• {asset.last4} · {asset.status === 'selected' ? '선택됨' : '조회됨'}</small></span></label>) : <p>조회된 카드가 없습니다. 보유카드 조회를 다시 실행해 주세요.</p>}<button className="submit" disabled={busy || !selectedIds.length} onClick={connectSelectedCards}>{busy ? '처리 중…' : `선택 ${selectedIds.length}장 연결하고 90일 내역 가져오기`}</button></div>}
    {step === 'syncing' && <div className="connection-syncing" role="status"><i/><div><b>승인·취소·매입 내역을 대조하고 있어요</b><span>화면을 닫지 말고 잠시 기다려 주세요.</span></div></div>}
    {step === 'complete' && <div className="connection-complete"><div><b>{connection?.status === 'reauth_required' ? '카드사 재인증이 필요해요' : connection?.status === 'degraded' ? '자동 수집을 다시 확인해 주세요' : '카드 자동 연결이 완료됐어요'}</b><span>{connection?.status === 'reauth_required' ? '카드사 인증이 만료되었거나 변경되었습니다. 인증정보 갱신 전까지 자동 재시도하지 않습니다.' : connection?.status === 'degraded' ? `${connection.last_error_category || '일시 오류'} · ${connection.next_sync_at ? `${new Date(connection.next_sync_at).toLocaleString('ko-KR')} 자동 재시도` : '재시도 대기 중'}` : result ? `신규 ${result.imported || 0}건 · 중복 제외 ${result.duplicates || 0}건 · 거래 ${result.groups || 0}개` : '마지막으로 연결된 카드의 자동 수집 상태입니다.'}</span></div>{connection?.status === 'degraded' ? <button className="outline" disabled={busy} onClick={retrySync}>{busy ? '동기화 중…' : '지금 다시 동기화'}</button> : connection?.status === 'reauth_required' ? <button className="outline" onClick={() => { setStep('reauth'); setError(''); }}>인증정보 갱신</button> : <button className="outline" onClick={() => { setStep('cards'); setError(''); loadAssets(); }}>카드 다시 선택</button>}</div>}
    {step === 'reauth' && <div className="connection-reauth"><div><b>카드사 인증정보 갱신</b><span>입력값은 서버에서 암호화되며 화면과 변경 이력에 원문을 남기지 않습니다.</span></div><div className="connection-reauth-grid"><label>카드사 코드<input autoComplete="off" value={reauthForm.cardCompanyCode} onChange={event => setReauthForm(value => ({ ...value, cardCompanyCode: event.target.value }))} placeholder="계약 명세의 카드사 코드"/></label><label>사업자번호<input inputMode="numeric" autoComplete="off" value={reauthForm.businessNumber} onChange={event => setReauthForm(value => ({ ...value, businessNumber: event.target.value }))} placeholder="숫자만 입력"/></label><label>인증 방식<select value={reauthForm.loginMethod} onChange={event => setReauthForm(value => ({ ...value, loginMethod: event.target.value }))}><option value="id_password">아이디·비밀번호</option><option value="certificate">공동인증서</option></select></label><label>카드사 로그인 ID<input autoComplete="username" value={reauthForm.loginId} onChange={event => setReauthForm(value => ({ ...value, loginId: event.target.value }))}/></label><label>카드사 비밀번호<input type="password" autoComplete="new-password" value={reauthForm.password} onChange={event => setReauthForm(value => ({ ...value, password: event.target.value }))}/></label></div><div className="connection-reauth-actions"><button className="outline" disabled={busy} onClick={() => setStep('complete')}>취소</button><button className="submit" disabled={busy} onClick={submitReauthentication}>{busy ? '인증 확인 중…' : '안전하게 갱신'}</button></div></div>}
    {history.length > 0 && <div className="connection-history"><b>연결 변경 이력</b>{history.slice(0, 5).map(item => <span key={item.id}><i/>{item.action === 'credentials_refreshed' ? '인증정보 갱신' : item.action} · {new Date(item.created_at).toLocaleString('ko-KR')}</span>)}</div>}
    {error && <div className="connection-error" role="alert"><span>{error}</span><button onClick={() => setError('')}>닫기</button></div>}
  </div>;
}
