const ACCESS_DENIED_PATTERN = /403|permission|denied|forbidden|row-level security|42501/i;

export const MANAGEMENT_ACCESS_CHANGED_MESSAGE =
  "관리자 권한이 변경되어 작업을 진행할 수 없어요. 직원 화면으로 전환했습니다.";

export function hasCurrentManagementPermission(context, permission) {
  if (context?.isOrganizationOwner) return true;
  if (!context?.managementAccount || context.managementAccount.status === "suspended")
    return false;
  return context.managementAccount.permissions?.includes(permission) === true;
}

export function managementActionErrorMessage(error, fallback) {
  const message = String(error?.message || error || "");
  return ACCESS_DENIED_PATTERN.test(message)
    ? MANAGEMENT_ACCESS_CHANGED_MESSAGE
    : message || fallback;
}
