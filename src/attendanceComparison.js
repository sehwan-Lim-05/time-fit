export function buildAttendanceComparisonRows(profile, schedules, policy, calculate) {
  const records = new Map((profile.attendanceHistory || []).map(record => [record.work_date, record]));
  const planned = new Map(Object.entries(schedules || {})
    .map(([date, entries]) => [date, entries.find(row => row[4] === profile.id || (!row[4] && row[0] === profile.name))])
    .filter(([, row]) => row));
  return [...new Set([...records.keys(), ...planned.keys()])].sort((a, b) => b.localeCompare(a)).map(date => {
    const record = records.get(date);
    const row = planned.get(date);
    const [startsAt, endsAt] = row?.[1] && !['휴무', '연차'].includes(row[1]) ? String(row[1]).split(/\s*[–~]\s*/) : [];
    const schedule = startsAt && endsAt ? {
      staff_id: profile.id, work_date: date, starts_at: startsAt, ends_at: endsAt,
      break_minutes: Number(row[7]) || 0, break_paid: Boolean(row[10]), shift_name: row[2],
    } : null;
    const calculation = calculate(record, schedule ? [schedule] : [], policy);
    return {
      date, schedule: row?.[1] || '스케줄 없음', shiftName: row?.[2] || '',
      checkedInAt: record?.checked_in_at, checkedOutAt: record?.checked_out_at,
      grossMinutes: calculation.grossMinutes, deductedBreakMinutes: calculation.breakMinutes,
      netMinutes: Math.max(0, calculation.grossMinutes - calculation.breakMinutes),
      payableMinutes: calculation.payableMinutes, scheduledMinutes: calculation.scheduledMinutes,
      overtimeMinutes: calculation.overtimeMinutes, registeredBreakMinutes: Number(row?.[7]) || 0,
      breakPaid: Boolean(row?.[10]), completed: Boolean(record?.checked_in_at && record?.checked_out_at),
    };
  });
}
