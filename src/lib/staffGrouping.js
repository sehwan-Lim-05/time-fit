export function staffTypeLabel(value) {
  const label = String(value || "").trim();
  return label || "미분류";
}

export function groupStaffByType(items, selectType = (item) => item.team) {
  const groups = new Map();
  for (const item of items || []) {
    const type = staffTypeLabel(selectType(item));
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(item);
  }
  return [...groups].map(([type, staff]) => ({ type, staff }));
}
