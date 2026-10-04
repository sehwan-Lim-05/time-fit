const finite = (value, field) => {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) throw new Error(`급여 ${field} 값이 올바르지 않습니다.`);
  return number;
};

export function normalizePayrollDraftLine(line) {
  return {
    ...line,
    applied_rate: Math.round(finite(line.applied_rate, '단가')),
    scheduled_minutes: Math.round(finite(line.scheduled_minutes, '스케줄 시간')),
    worked_minutes: Math.round(finite(line.worked_minutes, '근무시간')),
    completed_work_days: Math.round(finite(line.completed_work_days, '완료 근무일') * 100) / 100,
    approved_leave_days: Math.round(finite(line.approved_leave_days, '승인 휴가') * 100) / 100,
    base_pay: Math.round(finite(line.base_pay, '기본 급여')),
    adjustment_amount: Math.round(finite(line.adjustment_amount, '조정 금액')),
    estimated_total: Math.round(finite(line.estimated_total, '예상 급여')),
  };
}
