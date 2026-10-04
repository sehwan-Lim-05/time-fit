-- Replace Butter Villa Gangneung's earlier 30-minute payroll rounding policy.
-- Unpaid breaks are deducted before each shift's payable minutes are rounded up.
update public.timefit_user_organization_settings as settings
set payroll_rounding_enabled = true,
    attendance_rounding_minutes = 10,
    attendance_rounding_mode = 'ceil',
    updated_at = now()
from public.timefit_user_organizations as organization
where settings.organization_id = organization.id
  and trim(organization.name) = '버터빌라 강릉'
  and (
    settings.payroll_rounding_enabled is distinct from true
    or settings.attendance_rounding_minutes is distinct from 10
    or settings.attendance_rounding_mode is distinct from 'ceil'
  );
