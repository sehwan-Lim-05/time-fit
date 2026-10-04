-- Butter Villa Gangneung: pay hourly staff in 30-minute increments, rounded up.
-- For example, 20 payable minutes count as 30 minutes; unpaid breaks are deducted first.
update public.timefit_user_organization_settings as settings
set payroll_rounding_enabled = true,
    attendance_rounding_minutes = 30,
    attendance_rounding_mode = 'ceil',
    updated_at = now()
from public.timefit_user_organizations as organization
where settings.organization_id = organization.id
  and trim(organization.name) = '버터빌라 강릉'
  and (
    settings.payroll_rounding_enabled is distinct from true
    or settings.attendance_rounding_minutes is distinct from 30
    or settings.attendance_rounding_mode is distinct from 'ceil'
  );
