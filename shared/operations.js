export const kstDate = (value = new Date()) => new Date(new Date(value).getTime() + 9 * 3600000).toISOString().slice(0, 10);
export const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
export function payrollAttendanceRange(month, today = kstDate()) {
  const [year, monthNumber] = month.split('-').map(Number);
  const monthEnd = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return { from: `${month}-01`, to: month === today.slice(0, 7) ? addDays(today, -1) : monthEnd };
}
export const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && addDays(value, 0) === value;
export function lastCompleteWeek(today = kstDate()) {
  const day = new Date(`${today}T00:00:00Z`).getUTCDay();
  const from = addDays(today, -((day + 6) % 7) - 7);
  return { from, to: addDays(from, 6), previousFrom: addDays(from, -7), previousTo: addDays(from, -1) };
}
export function recentCompletedWeek(today = kstDate()) {
  const to = addDays(today, -1);
  const from = addDays(to, -6);
  return { from, to, previousFrom: addDays(from, -7), previousTo: addDays(from, -1) };
}
export const changePercent = (current, previous) => previous > 0 ? (current - previous) / previous * 100 : null;

export function staffTodayStatus(attendance, schedules = [], staffId, today = kstDate(), now = new Date()) {
  if (attendance?.checked_out_at) return '퇴근 완료';
  if (attendance?.checked_in_at) return '근무 중';
  const schedule = schedules.find(row => row.staff_id === staffId && row.work_date === today && row.approval_status === 'approved');
  if (!schedule) return '일정 없음';
  if (schedule.is_day_off) return '휴무';
  if (!schedule.starts_at) return '일정 확인 필요';
  return Date.parse(`${today}T${schedule.starts_at}+09:00`) > +now ? '예정' : '미출근';
}

export function validAttendanceCorrection({ date, checkedIn, checkedOut, reason, requireCheckout = false }, now = new Date()) {
  const start = Date.parse(`${checkedIn}+09:00`), end = checkedOut ? Date.parse(`${checkedOut}+09:00`) : null;
  return validDate(date) && checkedIn.slice(0, 10) === date && Number.isFinite(start) && start <= +now
    && (!requireCheckout || end !== null) && (end === null || (Number.isFinite(end) && end > start && end <= +now && end - start <= 48 * 3600000))
    && reason.trim().length >= 2 && reason.length <= 500;
}

// Past, approved shifts only. Overnight shifts remain open until their end;
// without a schedule, an open record is only flagged after 24 hours.
export function attendanceIssues(employees, { from, to, now = new Date(), leaves = [] }) {
  const issues = [];
  for (const employee of employees) {
    const records = new Map((employee.attendanceHistory || []).map(row => [row.work_date, row]));
    const schedules = new Map((employee.scheduleHistory || []).filter(row => row.approval_status === 'approved').map(row => [row.work_date, row]));
    for (const date of new Set([...records.keys(), ...schedules.keys()])) {
      if (date < from || date > to || date >= kstDate(now)) continue;
      const record = records.get(date), schedule = schedules.get(date);
      const working = schedule && !schedule.is_day_off && schedule.starts_at && schedule.ends_at;
      const endDate = working && schedule.ends_at <= schedule.starts_at ? addDays(date, 1) : date;
      const ended = working && Date.parse(`${endDate}T${schedule.ends_at}+09:00`) <= +now;
      const approvedLeave = leaves.some(leave => leave.staffId === employee.id && leave.status === '승인 완료' && !String(leave.type).includes('반차') && parseFloat(leave.amount) >= 1 && leave.startsAt <= date && (leave.endsAt || leave.startsAt) >= date);
      const types = [];
      if (record?.checked_in_at && !record.checked_out_at && (working ? ended : +now - Date.parse(record.checked_in_at) >= 86400000)) types.push('checkout');
      if (working && ended && !record?.checked_in_at && !approvedLeave) types.push('absent');
      if (record?.checked_in_at && !working) types.push('schedule');
      if (types.length) issues.push({ key: `${employee.id}:${date}`, employee, date, record, schedule, types });
    }
  }
  return issues.sort((a, b) => a.date.localeCompare(b.date) || a.employee.name.localeCompare(b.employee.name));
}

const salesDelta = (current, previous) => ({
  amount: Number(current || 0) - Number(previous || 0),
  percent: Number(previous) > 0 ? (Number(current || 0) - Number(previous)) / Number(previous) * 100 : null,
});

const paidLine = line => {
  const quantity = Number(line?.quantity);
  const price = Number(line?.itemPrice?.priceValue);
  if (!line?.item?.title || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) return null;
  const unit = Math.max(1, Number(line.itemPrice?.priceUnit) || 1);
  const options = (line.optionChoices || []).reduce((sum, option) => sum + (Number(option?.priceValue) || 0) * Math.max(1, Number(option?.quantity) || 1), 0);
  const code = String(line.item?.code || line.item?.id || '').trim();
  const category = String(line.item?.category?.title || '미분류').trim();
  return { key: code || `${line.item.title.trim().toLowerCase()}:${category.toLowerCase()}`, code: code || null, name: line.item.title, category, quantity, sales: price * unit * quantity + options };
};

export function weeklySales(orders, daily, range, connection, syncRuns = []) {
  const completedRun = (from, to) => syncRuns.find(run => run.status === 'succeeded' && run.page_complete
    && Date.parse(run.window_from) <= Date.parse(`${from}T00:00:00+09:00`)
    && Date.parse(run.window_to) >= Date.parse(`${to}T23:59:59.999+09:00`));
  const summarize = (from, to) => {
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(from, i);
      const rows = orders.filter(order => kstDate(order.ordered_at) === date);
      const completed = rows.filter(order => order.state === 'COMPLETED');
      const cache = daily.find(row => row.sales_date === date);
      const revenue = completed.reduce((sum, order) => sum + Number(order.total_amount), 0);
      const cancelled = rows.filter(order => String(order.state || '').toLowerCase().includes('cancel')).length;
      const cacheMatched = Boolean(cache
        && Number(cache.order_count) === rows.length
        && (cache.completed_order_count === undefined || Number(cache.completed_order_count) === completed.length)
        && (cache.completed_amount === undefined || Number(cache.completed_amount) === revenue));
      return { date, revenue, orders: completed.length, cancelled, average: completed.length ? revenue / completed.length : null, covered: cacheMatched, dataStatus: cache?.finalization_status || (cacheMatched ? 'captured' : 'incomplete') };
    });
    const completed = orders.filter(order => order.state === 'COMPLETED' && kstDate(order.ordered_at) >= from && kstDate(order.ordered_at) <= to);
    const menus = new Map();
    for (const order of completed) for (const line of order.raw_order?.lineItems || []) {
      const item = paidLine(line); if (!item) continue;
      const existing = menus.get(item.key) || { ...item, quantity: 0, sales: 0, orders: new Set() };
      existing.quantity += item.quantity; existing.sales += item.sales; existing.orders.add(order.order_id);
      menus.set(item.key, existing);
    }
    const revenue = days.reduce((sum, day) => sum + day.revenue, 0);
    const count = completed.length;
    const cancelled = days.reduce((sum, day) => sum + day.cancelled, 0);
    const run = completedRun(from, to);
    const revised = days.some(day => day.dataStatus === 'revised');
    const covered = days.every(day => day.covered) && Boolean(run);
    return { from, to, days, revenue, orders: count, cancelled, average: count ? revenue / count : null, menus: [...menus.values()].map(item => ({ ...item, orders: item.orders.size })), menuComplete: completed.every(order => Array.isArray(order.raw_order?.lineItems) && order.raw_order.lineItems.length > 0), covered, status: covered ? (revised ? 'revised' : 'finalized') : 'incomplete', run: run || null };
  };
  const current = summarize(range.from, range.to), previous = summarize(range.previousFrom, range.previousTo);
  const comparable = current.covered && previous.covered;
  const menuComparable = comparable && current.menuComplete && previous.menuComplete;
  const menus = current.menus.sort((a, b) => b.sales - a.sales || b.quantity - a.quantity || a.name.localeCompare(b.name)).slice(0, 10).map(menu => { const old = previous.menus.find(row => row.key === menu.key); return { key: menu.key, code: menu.code, name: menu.name, category: menu.category, quantity: menu.quantity, sales: menu.sales, orders: menu.orders, share: current.revenue ? menu.sales / current.revenue * 100 : 0, previous: menuComparable ? old?.quantity || 0 : null, previousSales: menuComparable ? old?.sales || 0 : null }; });
  const deltas = { revenue: salesDelta(current.revenue, previous.revenue), orders: salesDelta(current.orders, previous.orders), average: current.average === null ? { amount: null, percent: null } : salesDelta(current.average, previous.average), cancelled: salesDelta(current.cancelled, previous.cancelled) };
  const coverageRuns = [current.run, previous.run].filter(Boolean);
  const coveredFrom = coverageRuns.length ? coverageRuns.map(run => run.window_from).sort()[0] : null;
  const coveredTo = coverageRuns.length ? coverageRuns.map(run => run.window_to).sort().at(-1) : null;
  delete current.menus; delete previous.menus;
  delete current.run; delete previous.run;
  return { current, previous, comparable, menuComparable, menus, deltas, status: { state: !comparable ? 'incomplete' : current.status === 'revised' || previous.status === 'revised' ? 'revised' : 'finalized', comparable, lastSyncedAt: connection?.last_synced_at || null, coveredFrom, coveredTo, pageComplete: coverageRuns.length === 2 && coverageRuns.every(run => run.page_complete), cacheMatched: current.days.every(day => day.covered) && previous.days.every(day => day.covered), revisionCount: daily.reduce((sum, row) => sum + Number(row.revision_number || 0), 0), errorMessage: connection?.last_error || null }, syncedAt: connection?.last_synced_at || null, syncError: Boolean(connection?.last_error), connected: Boolean(connection?.merchant_id) };
}
