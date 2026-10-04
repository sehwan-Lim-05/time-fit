import { cardRoutes } from '../../server/routes/cards.js';
import { financeRoutes } from '../../server/routes/finance.js';
import { operationRoutes } from '../../server/routes/operations.js';
import { salesRoutes } from '../../server/routes/sales.js';

const groups = [salesRoutes, financeRoutes, cardRoutes, operationRoutes];
export const config = { maxDuration: 300 };
export const handlers = Object.freeze(Object.assign(Object.create(null), ...groups));

export default function handler(req, res) {
  const queryRoute = Array.isArray(req.query?.route) ? req.query.route.join('/') : String(req.query?.route || '');
  const route = queryRoute || String(req.url || '').split('?')[0].replace(/^\/api\//, '').replace(/^\/+|\/+$/g, '');
  const target = handlers[route];
  if (!target) return res.status(404).json({ ok: false, error: 'API route not found' });
  return target(req, res);
}
