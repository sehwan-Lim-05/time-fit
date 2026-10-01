import React, { useEffect, useMemo, useState } from 'react';
import { uploadReceiptToGoogleDrive } from '../../lib/supabase';

export default function EmployeeReceiptSubmission({ organizationId, employee }) {
  const [files, setFiles] = useState([]);
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const previews = useMemo(() => files.filter(file => file.type.startsWith('image/')).map(file => ({ file, url: URL.createObjectURL(file) })), [files]);

  useEffect(() => () => previews.forEach(item => URL.revokeObjectURL(item.url)), [previews]);

  const selectFiles = event => {
    const selected = Array.from(event.target.files || []).slice(0, 20);
    setFiles(selected); setUploadedFiles([]);
    setMessage(selected.length ? `${selected.length}개 원본 파일을 Google Drive에 저장할 준비가 됐어요.` : '');
  };

  const submit = async event => {
    event.preventDefault();
    if (!files.length) return setMessage('촬영한 영수증 또는 파일을 선택해 주세요.');
    setBusy(true); setMessage('Google Drive에 원본을 저장하고 있어요.');
    try {
      const uploaded = [];
      for (const file of files) uploaded.push(await uploadReceiptToGoogleDrive({ organizationId, file }));
      setUploadedFiles(uploaded); setFiles([]); event.currentTarget.reset();
      setMessage('원본 저장이 완료됐습니다. 아래 링크에서 파일을 확인할 수 있어요.');
    } catch (error) { setMessage(error.message || 'Google Drive에 영수증을 업로드하지 못했습니다.'); }
    finally { setBusy(false); }
  };

  if (!employee) return <section className="card full-card empty-schedule"><b>직원 연결이 필요해요.</b><span>관리자에게 현재 로그인 계정과 직원 정보를 연결해 달라고 요청해 주세요.</span></section>;

  return <>
    <div className="page-title"><div><p>원본 파일 보관</p><h1>내 영수증</h1><span>촬영한 원본을 Google Drive에 저장하고 파일 링크를 바로 확인합니다.</span></div></div>
    <section className="card full-card employee-receipt-card">
      <div className="card-title"><div><h2>영수증 촬영·업로드</h2><p>현재는 원본 보관만 지원하며 OCR, 지출 저장, 카드 대조 및 검토는 실행하지 않습니다.</p></div></div>
      {uploadedFiles.length > 0 && <div className="manager-receipt-success" role="status">
        <span className="manager-receipt-success-icon" aria-hidden="true">✓</span>
        <div><b>Google Drive 저장 완료</b><p>{message}</p><small>Drive 폴더 접근 권한이 있는 계정으로 링크를 열어 주세요.</small></div>
        {uploadedFiles.map((file, index) => <a key={file.id} className="outline" href={file.webViewLink} target="_blank" rel="noreferrer">{index + 1}. {file.name || '영수증 원본'} 열기</a>)}
        <button type="button" className="outline" onClick={() => { setUploadedFiles([]); setMessage(''); }}>다른 영수증 업로드</button>
      </div>}
      {!uploadedFiles.length && <form onSubmit={submit}>
        <label className="receipt-camera-input"><input name="receipt" type="file" accept="image/*,application/pdf" capture="environment" multiple onChange={selectFiles}/><strong>{files.length ? `${files.length}개 파일 선택됨` : '카메라로 촬영 또는 파일 선택'}</strong><span>원본 그대로 Google Drive에 저장 · 파일당 최대 20MB</span></label>
        {previews.length > 0 && <div className="receipt-preview-strip">{previews.map((item, index) => <figure key={`${item.file.name}-${index}`}><img src={item.url} alt={`영수증 ${index + 1} 미리보기`}/><figcaption>{index + 1}번</figcaption></figure>)}<button type="button" className="outline" onClick={() => setFiles([])}>다시 선택</button></div>}
        <button className="cta receipt-submit-button" disabled={busy || !files.length}>{busy ? 'Drive 저장 중…' : 'Google Drive에 저장'}</button>
      </form>}
      {message && !uploadedFiles.length && <p className={/못|필요|실패/.test(message) ? 'receipt-submit-message error' : 'receipt-submit-message'}>{message}</p>}
    </section>
  </>;
}
