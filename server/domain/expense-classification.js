export const normalizeMerchantKey = value => String(value || '')
  .toLowerCase()
  .replace(/주식회사|\(주\)|㈜/g, '')
  .replace(/[^0-9a-z가-힣]/g, '');

const CATEGORY_KEYWORDS = [
  ['재료비', /식자재|식품|프레시|fresh|마트|농산|축산|수산|정육|야채|채소|과일|우유|버터|밀가루|치즈|크림|계란/],
  ['소모품비', /포장|용기|컵|냅킨|세제|수세미|장갑|봉투|빨대|휴지/],
  ['교통비', /주유|택시|교통|주차|고속도로/],
  ['공과금', /전기|가스|수도|통신/],
  ['임차료', /임대|임차|월세/],
  ['접대비', /접대/],
];

export function inferExpenseCategory({ merchantName, lineItems = [] } = {}) {
  const searchable = [merchantName, ...lineItems.flatMap(item => [item.itemNameRaw, item.itemNameNormalized])].filter(Boolean).join(' ').toLowerCase();
  const matched = CATEGORY_KEYWORDS.find(([, pattern]) => pattern.test(searchable));
  return { category: matched?.[0] || '기타', source: matched ? 'keyword' : 'fallback', confidence: matched ? 0.75 : 0.4 };
}

export function findPriorMerchantClassification(receipt, priorExpenses = []) {
  const businessNumber = String(receipt?.merchantBusinessNumber || '').replace(/\D/g, '');
  const merchantKey = normalizeMerchantKey(receipt?.merchantName);
  return priorExpenses.find(expense => {
    if (!expense.category) return false;
    const priorBusinessNumber = String(expense.merchant_business_number || '').replace(/\D/g, '');
    return (businessNumber && priorBusinessNumber === businessNumber) || (merchantKey && normalizeMerchantKey(expense.merchant_name) === merchantKey);
  }) || null;
}
