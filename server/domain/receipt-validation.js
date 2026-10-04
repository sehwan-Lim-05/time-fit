import { MAX_SINGLE_EXPENSE_AMOUNT } from './expense-amount-validation.js';

const amount = value => Number.isFinite(Number(value)) ? Math.round(Number(value)) : null;

export function receiptValidation(extracted = {}) {
  const issues = [];
  const totalAmount = amount(extracted.totalAmount);
  const supplyAmount = amount(extracted.supplyAmount);
  const vatAmount = amount(extracted.vatAmount);
  const taxFreeAmount = amount(extracted.taxFreeAmount) || 0;
  const lineItemTotal = (extracted.lineItems || []).reduce((sum, item) => sum + (amount(item.lineAmount) || 0), 0);

  if (!extracted.merchantName) issues.push({ code: 'merchant_missing', field: 'merchantName', severity: 'required' });
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(extracted.transactionDate || '')) issues.push({ code: 'date_missing', field: 'transactionDate', severity: 'required' });
  if (totalAmount === null || totalAmount <= 0) issues.push({ code: 'total_missing', field: 'totalAmount', severity: 'required' });
  if (totalAmount !== null && totalAmount > MAX_SINGLE_EXPENSE_AMOUNT) issues.push({ code: 'total_amount_outlier', field: 'totalAmount', severity: 'required', maximum: MAX_SINGLE_EXPENSE_AMOUNT });
  if (totalAmount !== null && supplyAmount !== null && vatAmount !== null && supplyAmount + vatAmount + taxFreeAmount !== totalAmount) {
    issues.push({ code: 'tax_total_mismatch', field: 'totalAmount', severity: 'review' });
  }
  const lineItemDifference = totalAmount === null ? null : totalAmount - lineItemTotal;
  if (lineItemTotal > 0 && lineItemDifference !== 0) issues.push({ code: 'line_item_total_mismatch', field: 'lineItems', severity: 'review', difference: lineItemDifference });
  for (const [index, item] of (extracted.lineItems || []).entries()) {
    const quantity = Number(item.quantity); const unitPrice = amount(item.unitPrice); const lineAmount = amount(item.lineAmount);
    if (Number.isFinite(quantity) && unitPrice !== null && lineAmount !== null && Math.abs(quantity * unitPrice - lineAmount) >= 1) issues.push({ code: 'line_item_arithmetic_mismatch', field: 'lineItems', severity: 'review', lineNumber: item.lineNumber || index + 1, expected: Math.round(quantity * unitPrice), actual: lineAmount });
  }
  for (const [field, confidence] of Object.entries(extracted.fieldConfidence || {})) {
    if (Number(confidence) < 0.7) issues.push({ code: 'low_confidence', field, severity: 'review', confidence: Number(confidence) || 0 });
  }
  return {
    validForManagerReview: !issues.some(issue => issue.severity === 'required'),
    requiresSubmitterReview: issues.some(issue => issue.severity === 'required' || ['merchantName','transactionDate','totalAmount'].includes(issue.field)),
    lineItemTotal,
    lineItemDifference,
    issues,
  };
}

export function receiptPriority({ reviewStatus, processingStatus, createdAt, totalAmount, validationResult = {} }, now = Date.now()) {
  const ageDays = Math.max(0, Math.floor((now - new Date(createdAt).getTime()) / 86400000));
  let score = 0;
  if (processingStatus === 'failed') score += 1000;
  if (reviewStatus === 'change_requested') score += 900;
  if ((validationResult.issues || []).some(issue => issue.severity === 'required')) score += 700;
  score += Math.min(ageDays, 30) * 20;
  score += Math.min(Math.round((Number(totalAmount) || 0) / 100000), 100);
  return { score, ageDays };
}

export function canTransitionReceiptReview(from, to) {
  const allowed = {
    draft: ['submitted','withdrawn'],
    submitted: ['submitter_review','manager_review','withdrawn'],
    submitter_review: ['resubmitted','withdrawn'],
    manager_review: ['change_requested','approved','rejected'],
    change_requested: ['resubmitted','withdrawn'],
    resubmitted: ['submitter_review','manager_review'],
    approved: [], rejected: [], withdrawn: [],
  };
  return Boolean(allowed[from]?.includes(to));
}
