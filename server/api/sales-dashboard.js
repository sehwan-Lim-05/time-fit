const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function unauthorized(res) { res.setHeader("WWW-Authenticate", 'Basic realm="TimeFit Sales"'); return res.status(401).send("Authentication required"); }
function isAuthorized(req) {
  const header = req.headers.authorization;
  if (!process.env.DASHBOARD_USERNAME || !process.env.DASHBOARD_PASSWORD || !header?.startsWith("Basic ")) return false;
  try { const separator = Buffer.from(header.slice(6), "base64").toString("utf8").indexOf(":"); const raw = Buffer.from(header.slice(6), "base64").toString("utf8"); return raw.slice(0, separator) === process.env.DASHBOARD_USERNAME && raw.slice(separator + 1) === process.env.DASHBOARD_PASSWORD; } catch { return false; }
}
function isoDate(value, endOfDay = false) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return null; const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+09:00`); return Number.isNaN(date.valueOf()) ? null : date.toISOString(); }
function headers() { const key = process.env.SUPABASE_SERVICE_ROLE_KEY; return { apikey: key, Authorization: `Bearer ${key}` }; }

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });
  if (!isAuthorized(req)) return unauthorized(res);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.TOSSPLACE_MERCHANT_ID) return res.status(503).json({ ok: false, error: "Dashboard is not configured" });
  const page = Math.max(1, Number.parseInt(req.query.page ?? "1", 10) || 1);
  const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(req.query.size ?? DEFAULT_PAGE_SIZE, 10) || DEFAULT_PAGE_SIZE));
  const from = isoDate(req.query.from), to = isoDate(req.query.to, true), merchantId = process.env.TOSSPLACE_MERCHANT_ID;
  const filters = [`merchant_id=eq.${encodeURIComponent(merchantId)}`];
  if (from) filters.push(`ordered_at=gte.${encodeURIComponent(from)}`); if (to) filters.push(`ordered_at=lte.${encodeURIComponent(to)}`);
  try {
    const filterQuery = filters.join("&");
    const [summaryResponse, ordersResponse] = await Promise.all([
      fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/tossplace_sales_summary`, { method: "POST", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify({ p_merchant_id: Number(merchantId), p_from: from, p_to: to }) }),
      fetch(`${process.env.SUPABASE_URL}/rest/v1/tossplace_orders?${filterQuery}&select=order_id,ordered_at,completed_at,cancelled_at,state,source,total_amount&order=ordered_at.desc&limit=${size}&offset=${(page - 1) * size}`, { headers: headers() }),
    ]);
    if (!summaryResponse.ok || !ordersResponse.ok) throw new Error(`Supabase sales read failed: ${summaryResponse.status}/${ordersResponse.status}`);
    const [summaryRows, orders] = await Promise.all([summaryResponse.json(), ordersResponse.json()]); const summary = summaryRows[0] ?? {};
    return res.status(200).json({ ok: true, page, size, filters: { from: req.query.from ?? null, to: req.query.to ?? null }, summary: { orderCount: Number(summary.order_count) || 0, completedOrderCount: Number(summary.completed_order_count) || 0, completedAmount: Number(summary.completed_amount) || 0, cancelledCount: Number(summary.cancelled_count) || 0 }, orders, hasNextPage: orders.length === size });
  } catch (error) { console.error("Sales dashboard read failed", { message: error.message }); return res.status(502).json({ ok: false, error: "Sales data read failed" }); }
}
