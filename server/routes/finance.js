import closeouts from '../api/closeouts.js';
import expenseDetail from '../api/expense-detail.js';
import expenseExceptions from '../api/expense-exceptions.js';
import expenseReminderWorker from '../api/expense-reminder-worker.js';
import expenseReview from '../api/expense-review.js';
import expenses from '../api/expenses.js';
import financeReport from '../api/finance-report.js';
import receiptProcess from '../api/receipt-process.js';

export const financeRoutes = Object.freeze({
  closeouts,
  'expense-detail': expenseDetail,
  'expense-exceptions': expenseExceptions,
  'expense-reminder-worker': expenseReminderWorker,
  'expense-review': expenseReview,
  expenses,
  'finance-report': financeReport,
  'receipt-process': receiptProcess,
});
