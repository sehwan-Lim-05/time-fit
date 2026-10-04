import { authorizeFinance, financeError, financeRest, financeServerConfigured, methodNotAllowed } from './_finance-server.js';

const DAY_MS = 86400000;

export function dueReminderNumber({ approvedAt, now = new Date(), firstAfterDays = 3, repeatDays = 3, maxCount = 3, sentCount = 0 }) {
  const approved = new Date(approvedAt);
  if (Number.isNaN(approved.getTime())) return null;
  const ageDays = Math.floor((now.getTime() - approved.getTime()) / DAY_MS);
  if (ageDays < firstAfterDays || sentCount >= maxCount) return null;
  const dueLevel = Math.min(maxCount, 1 + Math.floor((ageDays - firstAfterDays) / repeatDays));
  return dueLevel > sentCount ? sentCount + 1 : null;
}

const authorized = req => {
  const supplied = req.headers.authorization;
  return [process.env.EXPENSE_REMINDER_CRON_SECRET, process.env.CRON_SECRET]
    .filter(Boolean).some(secret => supplied === `Bearer ${secret}`);
};

const reminderMessage = transaction => {
  const merchant = transaction.merchant_name || '사용처 미확인';
  const amount = Number(transaction.net_amount || 0).toLocaleString('ko-KR');
  const card = transaction.card?.nickname || transaction.card?.issuer || '법인카드';
  return `${merchant} ${amount}원 (${card} •••• ${transaction.card?.last4 || '----'}) 영수증을 촬영해 등록해 주세요.`;
};

export default async function handler(req, res) {
  if (!['GET','POST'].includes(req.method)) return methodNotAllowed(res);
  const requestedOrganizationId = req.body?.organizationId;
  if (req.method === 'GET' && !authorized(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (!financeServerConfigured()) return res.status(503).json({ ok: false, error: 'Missing server configuration' });
  if (req.method === 'POST' && !await authorizeFinance(req, requestedOrganizationId)) return res.status(req.headers.authorization ? 403 : 401).json({ ok: false, error: '관리자 인증이 필요합니다.' });
  try {
    const now = new Date();
    const organizationFilter = requestedOrganizationId ? `&organization_id=eq.${encodeURIComponent(requestedOrganizationId)}` : '';
    const settings = await financeRest(`timefit_user_organization_settings?receipt_reminder_enabled=eq.true${organizationFilter}&select=organization_id,receipt_reminder_first_after_days,receipt_reminder_repeat_days,receipt_reminder_max_count&limit=100`);
    const results = [];
    for (const setting of settings) {
      const organizationId = setting.organization_id;
      const cutoff = new Date(now.getTime() - Number(setting.receipt_reminder_first_after_days) * DAY_MS).toISOString();
      const [transactions, sources, reminders] = await Promise.all([
        financeRest(`timefit_user_card_transaction_groups?organization_id=eq.${encodeURIComponent(organizationId)}&reconciliation_status=eq.unreviewed&net_amount=gt.0&approved_at=lte.${encodeURIComponent(cutoff)}&select=id,corporate_card_id,merchant_name,net_amount,approved_at,card:timefit_user_corporate_cards(issuer,nickname,last4,holder_staff_id)&order=approved_at.asc&limit=250`),
        financeRest(`timefit_user_expense_sources?organization_id=eq.${encodeURIComponent(organizationId)}&source_type=eq.card_transaction_group&select=source_id&limit=1000`),
        financeRest(`timefit_user_expense_receipt_reminders?organization_id=eq.${encodeURIComponent(organizationId)}&channel=eq.in_app&select=transaction_group_id,reminder_number,status&limit=1000`),
      ]);
      const linked = new Set(sources.map(source => source.source_id));
      const sentCounts = reminders.reduce((map, reminder) => {
        if (!['cancelled','failed'].includes(reminder.status)) map.set(reminder.transaction_group_id, Math.max(map.get(reminder.transaction_group_id) || 0, reminder.reminder_number));
        return map;
      }, new Map());
      const rows = transactions.flatMap(transaction => {
        if (linked.has(transaction.id)) return [];
        const reminderNumber = dueReminderNumber({ approvedAt: transaction.approved_at, now, firstAfterDays: Number(setting.receipt_reminder_first_after_days), repeatDays: Number(setting.receipt_reminder_repeat_days), maxCount: Number(setting.receipt_reminder_max_count), sentCount: sentCounts.get(transaction.id) || 0 });
        if (!reminderNumber) return [];
        return [{ organization_id: organizationId, transaction_group_id: transaction.id, corporate_card_id: transaction.corporate_card_id, staff_id: transaction.card?.holder_staff_id || null, reminder_number: reminderNumber, channel: 'in_app', status: 'sent', scheduled_for: now.toISOString(), sent_at: now.toISOString(), message: reminderMessage(transaction) }];
      });
      if (rows.length) await financeRest('timefit_user_expense_receipt_reminders?on_conflict=transaction_group_id,reminder_number,channel', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(rows) });
      results.push({ organizationId, scanned: transactions.length, created: rows.length });
    }
    return res.status(200).json({ ok: true, organizations: results.length, created: results.reduce((sum, item) => sum + item.created, 0), results });
  } catch (error) {
    return financeError(res, error, '영수증 미제출 알림 생성을 완료하지 못했습니다.');
  }
}
