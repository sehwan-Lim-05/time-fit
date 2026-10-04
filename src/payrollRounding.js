export function roundPayableMinutes(minutes, policy = {}) {
  const value = Math.max(0, Number(minutes) || 0);
  if (!value || policy.payroll_rounding_enabled === false) return value;
  const unit = Number(policy.attendance_rounding_minutes || 30);
  if (!Number.isFinite(unit) || unit <= 0) return value;
  if (policy.attendance_rounding_mode === 'floor') return Math.floor(value / unit) * unit;
  if (policy.attendance_rounding_mode === 'nearest') return Math.round(value / unit) * unit;
  return Math.ceil(value / unit) * unit;
}
