import { after } from 'next/server.js';
import { createHash } from 'node:crypto';
import { authorizeFinance, authorizeOrganizationMember, canAccessFinanceCostCenter, financeError, financeRest, financeServerConfigured, methodNotAllowed, serviceHeaders } from './_finance-server.js';
import { extractReceiptWithLlm, mergeReceiptExtractions } from './_receipt-llm.js';
import { receiptValidation } from '../domain/receipt-validation.js';
import { extractSpatialReceipt, normalizeOcrNumber } from '../domain/receipt-spatial-extraction.js';
import { expenseAmountError } from '../domain/expense-amount-validation.js';
import { findPriorMerchantClassification, inferExpenseCategory } from '../domain/expense-classification.js';

const extractAmount = text => {
  const dailySales = [...text.matchAll(/금일[ \t]*매출액[ \t]*[:：]?[ \t]*[₩￦]?[ \t]*([0-9][0-9,. \t]*)/gi)].map(match => normalizeOcrNumber(match[1])).filter(value => Number.isFinite(value) && value > 0);
  if (dailySales.length) return dailySales.at(-1);
  const excluded = String(text).replace(/(?:전\s*미수금|총\s*미수금|총\s*합계)[^\n]*/gi, '');
  const labelled = [...excluded.matchAll(/(?:\[?[ \t]*합[ \t]*계[ \t]*\]?|결제금액|받을금액|총액)[ \t]*[:：]?[ \t]*[₩￦]?[ \t]*([0-9][0-9,. \t]*)/gi)].map(match => normalizeOcrNumber(match[1])).filter(value => Number.isFinite(value) && value > 0);
  if (labelled.length) return labelled.at(-1);
  const amounts = [...excluded.matchAll(/[₩￦]\s*([0-9][0-9,.\s]*)/g)].map(match => normalizeOcrNumber(match[1])).filter(amount => amount > 0);
  return amounts.length ? Math.max(...amounts) : null;
};

const extractDate = text => {
  const match = text.match(/(20\d{2})[.\/-]\s*(\d{1,2})[.\/-]\s*(\d{1,2})/);
  if (!match) return null;
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
};

export const structuredReceipt = (text, annotation = null) => {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const businessNumber = text.match(/(?:사업자(?:등록)?번호|사업자)\s*[:：]?\s*(\d{3})[- ]?(\d{2})[- ]?(\d{5})/i);
  const approvalNumber = text.match(/(?:승인번호|승인 No\.?)\s*[:：]?\s*([0-9A-Za-z-]{4,})/i);
  const last4 = text.match(/(?:카드번호|카드)\s*[:：]?\s*(?:[*Xx#-]+\s*)?(\d{4})(?!\d)/i);
  const spatial = annotation ? extractSpatialReceipt(annotation, text) : {};
  return {
    merchantName: spatial.merchantName || lines.find(line => !/영수증|매출전표|거래\s*명세서|사업자|대표|전화|주소/i.test(line) && /[가-힣A-Za-z]/.test(line)) || null,
    transactionDate: extractDate(text), totalAmount: spatial.totalAmount || extractAmount(text),
    merchantBusinessNumber: spatial.merchantBusinessNumber || (businessNumber ? `${businessNumber[1]}-${businessNumber[2]}-${businessNumber[3]}` : null),
    approvalNumber: approvalNumber?.[1] || null, cardLast4: last4?.[1] || null,
    recipientName: spatial.recipientName || null, recipientBusinessNumber: spatial.recipientBusinessNumber || null,
    lineItems: spatial.lineItems || [], spatialExtraction: Boolean(spatial.spatialExtraction),
  };
};

export const receiptFingerprint = receipt => {
  if (!receipt?.transactionDate || !Number.isFinite(Number(receipt.totalAmount))) return null;
  const merchantIdentity = String(receipt.merchantBusinessNumber || receipt.approvalNumber || receipt.merchantName || '').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
  if (!merchantIdentity) return null;
  return createHash('sha256').update([receipt.transactionDate, Number(receipt.totalAmount), merchantIdentity, String(receipt.approvalNumber || ''), String(receipt.cardLast4 || '')].join('|')).digest('hex');
};

const normalizedRuleValue = value => String(value || '').toLowerCase().replace(/[^0-9a-z가-힣]/g, '');

export function matchingClassificationRule(receipt, rules = []) {
  const businessNumber = normalizedRuleValue(receipt.merchantBusinessNumber);
  const merchantName = normalizedRuleValue(receipt.merchantName);
  return rules.filter(rule => rule.is_active !== false).sort((a, b) => Number(b.match_type === 'merchant_business_number') - Number(a.match_type === 'merchant_business_number') || Number(b.priority || 0) - Number(a.priority || 0)).find(rule => rule.match_type === 'merchant_business_number' ? businessNumber && rule.match_value === businessNumber : merchantName && rule.match_value === merchantName) || null;
}

export const matchScore = (receipt, transaction) => {
  const breakdown = {};
  if (receipt.totalAmount && Number(transaction.net_amount) === Number(receipt.totalAmount)) breakdown.amount = 45;
  if (receipt.transactionDate && String(transaction.approved_at || '').slice(0, 10) === receipt.transactionDate) breakdown.date = 25;
  if (receipt.approvalNumber && transaction.approval_number === receipt.approvalNumber) breakdown.approvalNumber = 25;
  if (receipt.cardLast4 && transaction.card?.last4 === receipt.cardLast4) breakdown.cardLast4 = 5;
  const receiptTime = receipt.transactionTime && receipt.transactionDate ? new Date(`${receipt.transactionDate}T${receipt.transactionTime}:00+09:00`) : null;
  const transactionTime = transaction.approved_at ? new Date(transaction.approved_at) : null;
  const timeClose = receiptTime && transactionTime && Math.abs(receiptTime.getTime() - transactionTime.getTime()) <= 30 * 60 * 1000;
  const receiptMerchant = normalizedRuleValue(receipt.merchantName); const transactionMerchant = normalizedRuleValue(transaction.merchant_name);
  const baseScore = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  if ((timeClose || (receiptMerchant && transactionMerchant.includes(receiptMerchant))) && baseScore < 100) breakdown.context = Math.min(5, 100 - baseScore);
  return { score: Object.values(breakdown).reduce((sum, value) => sum + value, 0), breakdown };
};

export function receiptRetryBlocker(previousRuns = [], hasExpenseSource = false) {
  if (previousRuns.some(run => ['queued','processing'].includes(run.status))) return 'processing';
  if (previousRuns.length >= 5) return 'limit';
  if (hasExpenseSource) return 'already_processed';
  return null;
}

async function downloadDocument(path) {
  const response = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/authenticated/timefit-finance-documents/${path.split('/').map(encodeURIComponent).join('/')}`, { headers: serviceHeaders() });
  if (!response.ok) throw new Error(`receipt_download_${response.status}`);
  return Buffer.from(await response.arrayBuffer()).toString('base64');
}

async function visionText(content) {
  if (!process.env.GOOGLE_VISION_API_KEY) throw new Error('google_vision_not_configured');
  const response = await fetch('https://vision.googleapis.com/v1/images:annotate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GOOGLE_VISION_API_KEY },
    body: JSON.stringify({ requests: [{ image: { content }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] }] }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.responses?.[0]?.error) throw new Error(body.responses?.[0]?.error?.message || `google_vision_${response.status}`);
  const annotation = body.responses?.[0]?.fullTextAnnotation || null;
  return { text: annotation?.text || body.responses?.[0]?.textAnnotations?.[0]?.description || '', annotation };
}

const scheduleBackground = task => {
  try { after(task); }
  catch { Promise.resolve().then(task).catch(error => console.error('receipt_background_failed', error)); }
};

async function finishRun(runId, patch) {
  await financeRest(`timefit_user_expense_processing_runs?id=eq.${encodeURIComponent(runId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ...patch, finished_at: new Date().toISOString() }) });
}

async function expenseForDocument(organizationId, documentId) {
  const sources = await financeRest(`timefit_user_expense_sources?organization_id=eq.${encodeURIComponent(organizationId)}&source_type=eq.receipt&source_id=eq.${encodeURIComponent(documentId)}&select=expense_id&limit=1`);
  return sources[0]?.expense_id || null;
}

async function saveExtraction({ organizationId, document, runId, rawText, extracted, validation, model }) {
  const rows = await financeRest('timefit_user_receipt_extractions', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{
    organization_id: organizationId, document_id: document.id, processing_run_id: runId, raw_text: rawText.slice(0, 100000),
    normalized_header: extracted, field_confidence: extracted.fieldConfidence || {}, validation_result: validation,
    provider: extracted.extractionProvider || 'rules', model: model || null, extractor_version: 'receipt-v2',
  }]) });
  const extraction = rows[0];
  if (extracted.lineItems?.length) await financeRest('timefit_user_receipt_line_items', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(extracted.lineItems.map(item => ({
    organization_id: organizationId, document_id: document.id, extraction_id: extraction.id,
    line_number: item.lineNumber, raw_text: item.rawText || '', item_name_raw: item.itemNameRaw,
    item_name_normalized: item.itemNameNormalized, quantity: item.quantity, unit: item.unit,
    unit_price: item.unitPrice, discount_amount: item.discountAmount || 0, line_amount: item.lineAmount,
    tax_type: item.taxType || 'unknown', cost_center_id: document.cost_center_id || null, confidence: item.confidence,
  }))) });
  return extraction;
}

async function createOrUpdateExpense({ organizationId, document, extracted, classificationRule }) {
  const expenseId = await expenseForDocument(organizationId, document.id);
  const expensePatch = {
    transaction_date: extracted.transactionDate, supply_amount: extracted.supplyAmount, vat_amount: extracted.vatAmount,
    total_amount: extracted.totalAmount, merchant_name: extracted.merchantName, merchant_business_number: extracted.merchantBusinessNumber,
    category: classificationRule?.category || extracted.category, reason: document.submission_reason || classificationRule?.default_reason || null,
    staff_id: document.submitted_by_staff_id || null, classification_rule_id: classificationRule?.id || null,
    status: 'review_required', source_confidence: Number(extracted.confidence || 0), updated_at: new Date().toISOString(),
  };
  if (expenseId) {
    const rows = await financeRest(`timefit_user_expenses?id=eq.${encodeURIComponent(expenseId)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(expensePatch) });
    return rows[0];
  }
  const rows = await financeRest('timefit_user_expenses', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{ organization_id: organizationId, ...expensePatch, created_by: document.uploaded_by }]) });
  const expense = rows[0];
  await financeRest('timefit_user_expense_sources', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ organization_id: organizationId, expense_id: expense.id, source_type: 'receipt', source_id: document.id, is_primary: true, match_reason: { extractorVersion: 'receipt-v2' } }]) });
  return expense;
}

async function replaceCandidates({ organizationId, documentId, expense, extracted }) {
  await financeRest(`timefit_user_expense_matches?organization_id=eq.${encodeURIComponent(organizationId)}&document_id=eq.${encodeURIComponent(documentId)}&status=neq.confirmed`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  const from = `${extracted.transactionDate}T00:00:00+09:00`; const toDate = new Date(from); toDate.setDate(toDate.getDate() + 1);
  const transactions = await financeRest(`timefit_user_card_transaction_groups?organization_id=eq.${encodeURIComponent(organizationId)}&approved_at=gte.${encodeURIComponent(from)}&approved_at=lt.${encodeURIComponent(toDate.toISOString())}&select=*,card:timefit_user_corporate_cards(last4)&limit=100`);
  const candidates = transactions.map(item => ({ transaction: item, ...matchScore(extracted, item) })).filter(item => item.score >= 40).sort((a, b) => b.score - a.score).slice(0, 3);
  if (candidates.length) await financeRest('timefit_user_expense_matches', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(candidates.map(candidate => ({ organization_id: organizationId, expense_id: expense.id, transaction_group_id: candidate.transaction.id, document_id: documentId, status: 'suggested', score: candidate.score, score_breakdown: candidate.breakdown }))) });
  return candidates;
}

async function syncDirectAllocation({ organizationId, document, expense }) {
  if (!document.cost_center_id || !expense?.id) return;
  const existing = await financeRest(`timefit_user_expense_allocations?expense_id=eq.${encodeURIComponent(expense.id)}&select=id,allocation_method`);
  if (existing.some(item => item.allocation_method !== 'direct')) return;
  await financeRest(`timefit_user_expense_allocations?expense_id=eq.${encodeURIComponent(expense.id)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  await financeRest('timefit_user_expense_allocations', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{
    organization_id: organizationId, expense_id: expense.id, cost_center_id: document.cost_center_id,
    allocation_amount: Number(expense.total_amount || extracted.totalAmount || 0), allocation_rate: 1,
    allocation_method: 'direct', created_by: document.uploaded_by,
  }]) });
}

export async function processReceiptRun({ organizationId, documentId, runId }) {
  try {
    await financeRest('rpc/timefit_user_claim_receipt_processing_run', { method: 'POST', body: JSON.stringify({ p_run_id: runId }) });
    const documents = await financeRest(`timefit_user_finance_documents?id=eq.${encodeURIComponent(documentId)}&organization_id=eq.${encodeURIComponent(organizationId)}&select=*`);
    const document = documents[0]; if (!document) throw new Error('receipt_document_not_found');
    const pages = await financeRest(`timefit_user_finance_document_pages?document_id=eq.${encodeURIComponent(documentId)}&select=*&order=page_number.asc`);
    const sourcePages = pages.length ? pages : [{ storage_path: document.storage_path, mime_type: document.mime_type }];
    if (sourcePages.some(page => !String(page.mime_type || '').startsWith('image/'))) throw new Error('receipt_image_required');
    const pageResults = [];
    for (const page of sourcePages) {
      pageResults.push(await visionText(await downloadDocument(page.storage_path)));
      await financeRest(`timefit_user_expense_processing_runs?id=eq.${encodeURIComponent(runId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ heartbeat_at: new Date().toISOString() }) });
    }
    const text = pageResults.map(result => result.text).filter(Boolean).join('\n\n--- page ---\n\n');
    if (!text.trim()) throw new Error('receipt_text_not_found');
    const spatialPages = pageResults.map(result => structuredReceipt(result.text, result.annotation));
    const combined = structuredReceipt(text);
    const primary = spatialPages[0] || {};
    const ruleBased = {
      ...combined,
      ...primary,
      merchantName: primary.merchantName || combined.merchantName,
      merchantBusinessNumber: primary.merchantBusinessNumber || combined.merchantBusinessNumber,
      transactionDate: primary.transactionDate || combined.transactionDate,
      totalAmount: primary.totalAmount || combined.totalAmount,
      lineItems: spatialPages.flatMap(page => page.lineItems || []).map((item, index) => ({ ...item, lineNumber: index + 1 })),
    };
    let llmResult = null; let llmError = null;
    try { llmResult = await extractReceiptWithLlm(text); } catch (error) { llmError = error; }
    let extracted = mergeReceiptExtractions(ruleBased, llmResult);
    const rules = await financeRest(`timefit_user_expense_classification_rules?organization_id=eq.${encodeURIComponent(organizationId)}&is_active=eq.true&select=id,match_type,match_value,category,default_reason,priority,is_active,hit_count&order=priority.desc&limit=200`);
    const classificationRule = matchingClassificationRule(extracted, rules);
    if (classificationRule) {
      extracted = { ...extracted, category: classificationRule.category, categorySource: 'rule', categoryConfidence: 1, appliedRuleId: classificationRule.id, appliedRuleReason: classificationRule.default_reason || null };
    } else {
      const recentExpenses = await financeRest(`timefit_user_expenses?organization_id=eq.${encodeURIComponent(organizationId)}&category=not.is.null&merchant_name=not.is.null&status=neq.excluded&select=merchant_name,merchant_business_number,category,classification_rule_id,created_at&order=created_at.desc&limit=200`);
      const prior = findPriorMerchantClassification(extracted, recentExpenses);
      const inferred = prior ? { category: prior.category, source: 'merchant_history', confidence: 0.9 } : inferExpenseCategory(extracted);
      extracted = { ...extracted, category: inferred.category, categorySource: inferred.source, categoryConfidence: inferred.confidence, appliedRuleId: prior?.classification_rule_id || null };
    }
    const validation = receiptValidation(extracted);
    const extraction = await saveExtraction({ organizationId, document, runId, rawText: text, extracted, validation, model: llmResult?.model });
    const fingerprint = receiptFingerprint(extracted);
    const duplicates = fingerprint ? await financeRest(`timefit_user_finance_documents?organization_id=eq.${encodeURIComponent(organizationId)}&document_type=eq.receipt&receipt_fingerprint=eq.${encodeURIComponent(fingerprint)}&id=neq.${encodeURIComponent(documentId)}&review_status=not.in.(rejected,withdrawn)&select=id,title,created_at&order=created_at.asc&limit=1`) : [];
    if (duplicates[0]) {
      await financeRest(`timefit_user_finance_documents?id=eq.${encodeURIComponent(documentId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ processing_status: 'ready', review_status: 'submitter_review', extracted_data: { ...extracted, duplicateDocumentId: duplicates[0].id }, ocr_text: text.slice(0,50000), receipt_fingerprint: fingerprint, duplicate_of_document_id: duplicates[0].id, processing_error: 'duplicate_receipt_suspected', document_date: extracted.transactionDate, processed_at: new Date().toISOString() }) });
      await finishRun(runId, { status: 'succeeded', extraction_provider: extracted.extractionProvider, extraction_model: llmResult?.model || null, fallback_used: !llmResult, error_code: 'duplicate_receipt_suspected' });
      return { duplicateOfDocumentId: duplicates[0].id };
    }
    if (!validation.validForManagerReview) {
      await financeRest(`timefit_user_finance_documents?id=eq.${encodeURIComponent(documentId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ processing_status: 'ready', review_status: 'submitter_review', extracted_data: extracted, ocr_text: text.slice(0,50000), receipt_fingerprint: fingerprint, document_date: extracted.transactionDate, processed_at: new Date().toISOString() }) });
      await finishRun(runId, { status: 'succeeded', extraction_provider: extracted.extractionProvider, extraction_model: llmResult?.model || null, fallback_used: !llmResult, error_code: llmError ? String(llmError.message || 'llm_fallback').slice(0,160) : null });
      return;
    }
    const expense = await createOrUpdateExpense({ organizationId, document, extracted, classificationRule });
    await syncDirectAllocation({ organizationId, document, expense, extracted });
    await financeRest(`timefit_user_receipt_line_items?extraction_id=eq.${encodeURIComponent(extraction.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ expense_id: expense.id }) });
    const candidates = await replaceCandidates({ organizationId, documentId, expense, extracted });
    if (classificationRule) await financeRest(`timefit_user_expense_classification_rules?id=eq.${encodeURIComponent(classificationRule.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ hit_count: Number(classificationRule.hit_count || 0) + 1, last_applied_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
    await financeRest(`timefit_user_finance_documents?id=eq.${encodeURIComponent(documentId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ processing_status: 'ready', review_status: validation.requiresSubmitterReview ? 'submitter_review' : 'manager_review', payment_method: document.payment_method || extracted.paymentMethod, document_date: extracted.transactionDate, extracted_data: extracted, ocr_text: text.slice(0,50000), receipt_fingerprint: fingerprint, processed_at: new Date().toISOString() }) });
    await finishRun(runId, { status: 'succeeded', extraction_provider: extracted.extractionProvider, extraction_model: llmResult?.model || null, input_tokens: llmResult?.usage?.input_tokens || null, output_tokens: llmResult?.usage?.output_tokens || null, fallback_used: !llmResult, error_code: llmError ? String(llmError.message || 'llm_fallback').slice(0,160) : null });
    return { expenseId: expense.id, candidateCount: candidates.length };
  } catch (error) {
    await finishRun(runId, { status: 'failed', error_code: String(error.message || 'receipt_processing_failed').slice(0,160) }).catch(() => {});
    await financeRest(`timefit_user_finance_documents?id=eq.${encodeURIComponent(documentId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ processing_status: 'failed', review_status: 'submitter_review', processing_error: String(error.message || 'receipt_processing_failed').slice(0,300), processed_at: new Date().toISOString() }) }).catch(() => {});
    throw error;
  }
}

async function authorizeReceipt(req, organizationId, document) {
  const member = await authorizeOrganizationMember(req, organizationId);
  if (!member) return null;
  if (document?.uploaded_by === member.user.id) return { ...member, ownDocument: true };
  const manager = await authorizeFinance(req, organizationId, { permissionsAny: ['finance.view','expense.receipt.review','expense.manage'] });
  if (!manager || !await canAccessFinanceCostCenter(manager, organizationId, document?.cost_center_id)) return null;
  return manager;
}

export const isReceiptRunStale = (run, now = Date.now(), staleAfterMs = 10 * 60 * 1000) => {
  const activity = new Date(run?.heartbeat_at || run?.claimed_at || run?.started_at || run?.created_at || 0).getTime();
  return Number.isFinite(activity) && now - activity >= staleAfterMs;
};

export async function recoverStaleReceiptRuns(organizationId) {
  const active = await financeRest(`timefit_user_expense_processing_runs?organization_id=eq.${encodeURIComponent(organizationId)}&status=in.(queued,processing)&select=id,document_id,status,attempt_count,created_at,started_at,claimed_at,heartbeat_at&order=created_at.asc&limit=100`);
  const stale = active.filter(run => isReceiptRunStale(run));
  for (const run of stale) {
    if (Number(run.attempt_count || 0) >= 5) {
      await finishRun(run.id, { status: 'failed', error_code: 'receipt_retry_limit' });
      await financeRest(`timefit_user_finance_documents?id=eq.${encodeURIComponent(run.document_id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ processing_status: 'failed', review_status: 'submitter_review', processing_error: '자동 분석 재시도 횟수를 초과했습니다.', processed_at: new Date().toISOString() }) });
      continue;
    }
    await financeRest(`timefit_user_expense_processing_runs?id=eq.${encodeURIComponent(run.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'queued', error_code: 'stale_run_recovered', finished_at: null }) });
    await financeRest(`timefit_user_finance_documents?id=eq.${encodeURIComponent(run.document_id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ processing_status: 'queued', processing_error: null }) });
    scheduleBackground(() => processReceiptRun({ organizationId, documentId: run.document_id, runId: run.id }));
  }
  return { scanned: active.length, recovered: stale.filter(run => Number(run.attempt_count || 0) < 5).length, failed: stale.filter(run => Number(run.attempt_count || 0) >= 5).length };
}

async function enqueueRun({ organizationId, documentId, userId }) {
  const active = await financeRest(`timefit_user_expense_processing_runs?document_id=eq.${encodeURIComponent(documentId)}&status=in.(queued,processing)&select=id,status,attempt_count,created_at,started_at,claimed_at,heartbeat_at&limit=1`);
  if (active.length) {
    if (isReceiptRunStale(active[0]) && Number(active[0].attempt_count || 0) < 5) {
      await financeRest(`timefit_user_expense_processing_runs?id=eq.${encodeURIComponent(active[0].id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'queued', error_code: 'stale_run_recovered', finished_at: null }) });
      scheduleBackground(() => processReceiptRun({ organizationId, documentId, runId: active[0].id }));
      return { run: { ...active[0], status: 'queued' }, duplicateRequest: false, recovered: true };
    }
    return { run: active[0], duplicateRequest: true };
  }
  const recent = await financeRest(`timefit_user_expense_processing_runs?document_id=eq.${encodeURIComponent(documentId)}&select=id&order=created_at.desc&limit=5`);
  if (recent.length >= 5) throw new Error('receipt_retry_limit');
  const rows = await financeRest('timefit_user_expense_processing_runs', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{ organization_id: organizationId, document_id: documentId, status: 'queued', ocr_provider: 'google_vision', ocr_model: 'DOCUMENT_TEXT_DETECTION', extractor_version: 'receipt-v2', created_by: userId }]) });
  const run = rows[0];
  await financeRest(`timefit_user_finance_documents?id=eq.${encodeURIComponent(documentId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ processing_status: 'queued', processing_error: null }) });
  scheduleBackground(() => processReceiptRun({ organizationId, documentId, runId: run.id }));
  return { run, duplicateRequest: false };
}

export default async function handler(req, res) {
  if (!['GET','POST','PATCH'].includes(req.method)) return methodNotAllowed(res);
  if (!financeServerConfigured()) return res.status(503).json({ ok: false, error: '금융 처리 서버 설정이 필요합니다.' });
  const organizationId = req.method === 'GET' ? req.query?.organizationId : req.body?.organizationId;
  const documentId = req.method === 'GET' ? req.query?.documentId : req.body?.documentId;
  try {
    const documents = await financeRest(`timefit_user_finance_documents?id=eq.${encodeURIComponent(documentId || '')}&organization_id=eq.${encodeURIComponent(organizationId || '')}&document_type=eq.receipt&select=*`);
    const document = documents[0];
    if (!document) return res.status(404).json({ ok: false, error: '영수증 원본을 찾을 수 없습니다.' });
    const auth = await authorizeReceipt(req, organizationId, document);
    if (!auth) return res.status(req.headers.authorization ? 403 : 401).json({ ok: false, error: '영수증 접근 권한이 없습니다.' });

    if (req.method === 'GET') {
      const [pages, runs, extractions, source] = await Promise.all([
        financeRest(`timefit_user_finance_document_pages?document_id=eq.${encodeURIComponent(documentId)}&select=*&order=page_number.asc`),
        financeRest(`timefit_user_expense_processing_runs?document_id=eq.${encodeURIComponent(documentId)}&select=*&order=created_at.desc&limit=5`),
        financeRest(`timefit_user_receipt_extractions?document_id=eq.${encodeURIComponent(documentId)}&select=*&order=created_at.desc&limit=1`),
        financeRest(`timefit_user_expense_sources?organization_id=eq.${encodeURIComponent(organizationId)}&source_type=eq.receipt&source_id=eq.${encodeURIComponent(documentId)}&select=expense_id&limit=1`),
      ]);
      const extraction = extractions[0] || null;
      const lineItems = extraction ? await financeRest(`timefit_user_receipt_line_items?extraction_id=eq.${encodeURIComponent(extraction.id)}&select=*&order=line_number.asc`) : [];
      const expenseId = source[0]?.expense_id || null;
      const matches = expenseId ? await financeRest(`timefit_user_expense_matches?expense_id=eq.${encodeURIComponent(expenseId)}&document_id=eq.${encodeURIComponent(documentId)}&select=*,transaction:timefit_user_card_transaction_groups(*,card:timefit_user_corporate_cards(issuer,nickname,last4))&order=score.desc`) : [];
      return res.status(200).json({ ok: true, document, pages, runs, extraction, lineItems, expenseId, matches });
    }

    if (req.method === 'PATCH') {
      const canCorrect = auth.ownDocument || auth.isOwner || auth.permissions?.some(permission => ['expense.receipt.review','expense.manage'].includes(permission));
      if (!canCorrect) return res.status(403).json({ ok: false, error: '제출자 또는 영수증 검토 권한이 있는 관리자만 인식 결과를 수정할 수 있습니다.' });
      const current = document.extracted_data || {}; const input = req.body?.patch || {};
      const totalAmount = Number(input.totalAmount ?? current.totalAmount);
      const transactionDate = String(input.transactionDate ?? current.transactionDate ?? '');
      if (!/^20\d{2}-\d{2}-\d{2}$/.test(transactionDate) || !Number.isFinite(totalAmount) || totalAmount <= 0) return res.status(400).json({ ok: false, error: '거래일과 총금액을 확인해 주세요.' });
      if (expenseAmountError(totalAmount)) return res.status(400).json({ ok: false, code: 'expense_amount_outlier', error: expenseAmountError(totalAmount) });
      const next = { ...current, merchantName: String(input.merchantName ?? current.merchantName ?? '').trim() || null, transactionDate, totalAmount };
      await financeRest(`timefit_user_finance_documents?id=eq.${encodeURIComponent(documentId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ extracted_data: next, cost_center_id: input.costCenterId || document.cost_center_id, payment_method: input.paymentMethod || document.payment_method, review_status: 'resubmitted', submitter_confirmed_at: new Date().toISOString(), change_requested_at: null, change_request_reason: null }) });
      const expenseId = await expenseForDocument(organizationId, documentId);
      if (expenseId) await financeRest(`timefit_user_expenses?id=eq.${encodeURIComponent(expenseId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ transaction_date: transactionDate, total_amount: totalAmount, merchant_name: next.merchantName, status: 'review_required', updated_at: new Date().toISOString() }) });
      await financeRest('timefit_user_expense_audit_logs', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ organization_id: organizationId, entity_type: 'finance_document', entity_id: documentId, action: 'submitter_confirmed', before_value: current, after_value: next, actor_id: auth.user.id, source: 'user' }]) });
      const queued = await enqueueRun({ organizationId, documentId, userId: auth.user.id });
      return res.status(202).json({ ok: true, documentId, runId: queued.run.id, duplicateRequest: queued.duplicateRequest });
    }

    const queued = await enqueueRun({ organizationId, documentId, userId: auth.user.id });
    return res.status(202).json({ ok: true, documentId, runId: queued.run.id, status: queued.run.status, duplicateRequest: queued.duplicateRequest });
  } catch (error) {
    if (error.message === 'receipt_retry_limit') return res.status(409).json({ ok: false, error: '자동 재분석 횟수를 초과했습니다. 관리자에게 확인을 요청해 주세요.' });
    return financeError(res, error, '영수증 처리를 요청하지 못했습니다.');
  }
}
