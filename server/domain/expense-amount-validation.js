export const MAX_SINGLE_EXPENSE_AMOUNT = 1_000_000_000;

export const isExpenseAmountAnomalous = value => {
  const amount = Number(value);
  return !Number.isInteger(amount) || amount <= 0 || amount > MAX_SINGLE_EXPENSE_AMOUNT;
};

export const expenseAmountError = value => isExpenseAmountAnomalous(value)
  ? `단일 지출은 1원 이상 ${MAX_SINGLE_EXPENSE_AMOUNT.toLocaleString('ko-KR')}원 이하만 확정할 수 있습니다. 영수증 인식 금액을 확인해 주세요.`
  : null;
