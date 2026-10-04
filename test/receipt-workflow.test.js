import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransitionReceiptReview, receiptPriority, receiptValidation } from '../server/domain/receipt-validation.js';
import { isReceiptRunStale, matchScore } from '../server/api/receipt-process.js';
import { extractSpatialReceipt, normalizeOcrNumber } from '../server/domain/receipt-spatial-extraction.js';

const visionAnnotation = entries => ({ pages: [{ blocks: [{ paragraphs: [{ words: entries.map(([text, x, y]) => ({ symbols: [...text].map(character => ({ text: character })), boundingBox: { vertices: [{ x: x - 20, y: y - 8 }, { x: x + 20, y: y - 8 }, { x: x + 20, y: y + 8 }, { x: x - 20, y: y + 8 }] } })) }] }] }] });

test('영수증 필수값과 품목 합계를 제출자 확인 대상으로 분류한다', () => {
  const missing = receiptValidation({ transactionDate: '2026-09-23', totalAmount: 12000 });
  assert.equal(missing.validForManagerReview, false);
  assert.equal(missing.requiresSubmitterReview, true);
  assert.ok(missing.issues.some(issue => issue.code === 'merchant_missing'));

  const mismatch = receiptValidation({
    merchantName: '테스트상회', transactionDate: '2026-09-23', totalAmount: 12000,
    lineItems: [{ lineAmount: 5000 }, { lineAmount: 6000 }],
  });
  assert.equal(mismatch.validForManagerReview, true);
  assert.equal(mismatch.lineItemDifference, 1000);
  assert.ok(mismatch.issues.some(issue => issue.code === 'line_item_total_mismatch'));
});

test('영수증 검토 상태는 허용된 방향으로만 전환한다', () => {
  assert.equal(canTransitionReceiptReview('manager_review', 'change_requested'), true);
  assert.equal(canTransitionReceiptReview('change_requested', 'resubmitted'), true);
  assert.equal(canTransitionReceiptReview('approved', 'manager_review'), false);
  assert.equal(canTransitionReceiptReview('submitted', 'approved'), false);
});

test('분석 실패와 수정 요청을 일반 검토보다 먼저 보여준다', () => {
  const now = Date.parse('2026-09-23T00:00:00Z');
  const failed = receiptPriority({ reviewStatus: 'submitter_review', processingStatus: 'failed', createdAt: '2026-09-22', totalAmount: 1000 }, now);
  const change = receiptPriority({ reviewStatus: 'change_requested', processingStatus: 'ready', createdAt: '2026-09-22', totalAmount: 1000 }, now);
  const normal = receiptPriority({ reviewStatus: 'manager_review', processingStatus: 'ready', createdAt: '2026-09-20', totalAmount: 100000 }, now);
  assert.ok(failed.score > normal.score);
  assert.ok(change.score > normal.score);
});

test('매칭 문맥 점수는 총 100점을 넘지 않는다', () => {
  const result = matchScore(
    { merchantName: '테스트상회', transactionDate: '2026-09-23', transactionTime: '12:00', totalAmount: 12000, approvalNumber: 'A1', cardLast4: '1234' },
    { merchant_name: '테스트상회 강남점', approved_at: '2026-09-23T12:01:00+09:00', net_amount: 12000, approval_number: 'A1', card: { last4: '1234' } },
  );
  assert.equal(result.score, 100);
});

test('10분 이상 heartbeat가 없는 OCR 작업만 복구 대상으로 판정한다', () => {
  const now = Date.parse('2026-09-24T12:00:00Z');
  assert.equal(isReceiptRunStale({ heartbeat_at: '2026-09-24T11:49:59Z' }, now), true);
  assert.equal(isReceiptRunStale({ heartbeat_at: '2026-09-24T11:55:00Z' }, now), false);
});

test('OCR 숫자의 공백 천단위와 점 오인식을 원화 정수로 정규화한다', () => {
  assert.equal(normalizeOcrNumber('153, 195'), 153195);
  assert.equal(normalizeOcrNumber('1.215'), 1215);
  assert.equal(normalizeOcrNumber('0.6'), 0.6);
});

test('Vision 좌표로 공급자·공급받는 자와 거래명세서 품목 열을 재구성한다', () => {
  const annotation = visionAnnotation([
    ['주식회사', 130, 60], ['지프레시', 200, 60], ['주식회사버터빌라', 700, 60],
    ['437-86-00905', 170, 90], ['810-86-03669', 700, 90],
    ['품명', 170, 200], ['총수량', 450, 200], ['단가', 600, 200], ['금액', 760, 200],
    ['1', 30, 250], ['무', 150, 250], ['개', 300, 250], ['5', 450, 250], ['1,840', 600, 250], ['9,200', 760, 250],
    ['2', 30, 300], ['백오이', 150, 300], ['개', 300, 300], ['30', 450, 300], ['1,300', 600, 300], ['39,000', 760, 300],
    ['합계', 150, 700], ['금일매출액', 150, 800], ['153,', 730, 800], ['195', 780, 800],
  ]);
  const result = extractSpatialReceipt(annotation, '437-86-00905 810-86-03669');
  assert.equal(result.merchantName, '주식회사 지프레시');
  assert.equal(result.merchantBusinessNumber, '437-86-00905');
  assert.equal(result.recipientName, '주식회사버터빌라');
  assert.equal(result.recipientBusinessNumber, '810-86-03669');
  assert.equal(result.totalAmount, 153195);
  assert.deepEqual(result.lineItems.map(item => [item.itemNameRaw, item.quantity, item.unit, item.unitPrice, item.lineAmount, item.arithmeticValid]), [
    ['무', 5, '개', 1840, 9200, true],
    ['백오이', 30, '개', 1300, 39000, true],
  ]);
});

test('품목 수량×단가와 금액이 다르면 검토 이슈를 만든다', () => {
  const result = receiptValidation({ merchantName: '상점', transactionDate: '2026-09-01', totalAmount: 10000, lineItems: [{ lineNumber: 1, quantity: 2, unitPrice: 3000, lineAmount: 5000 }] });
  assert.ok(result.issues.some(issue => issue.code === 'line_item_arithmetic_mismatch' && issue.expected === 6000));
});
