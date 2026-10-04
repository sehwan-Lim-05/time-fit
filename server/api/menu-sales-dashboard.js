function unauthorized(res) { res.setHeader("WWW-Authenticate", 'Basic realm="TimeFit Sales"'); return res.status(401).send("Authentication required"); }
function isAuthorized(req) { const header = req.headers.authorization; if (!process.env.DASHBOARD_USERNAME || !process.env.DASHBOARD_PASSWORD || !header?.startsWith("Basic ")) return false; try { const raw = Buffer.from(header.slice(6), "base64").toString("utf8"), index = raw.indexOf(":"); return raw.slice(0, index) === process.env.DASHBOARD_USERNAME && raw.slice(index + 1) === process.env.DASHBOARD_PASSWORD; } catch { return false; } }
function isoDate(value, endOfDay = false) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return null; const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+09:00`); return Number.isNaN(date.valueOf()) ? null : date.toISOString(); }

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });
  if (!isAuthorized(req)) return unauthorized(res);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.TOSSPLACE_MERCHANT_ID) return res.status(503).json({ ok: false, error: "Dashboard is not configured" });
  const from = isoDate(req.query.from), to = isoDate(req.query.to, true), limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit ?? "100", 10) || 100));
  try {
    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/tossplace_menu_sales_summary`, { method: "POST", headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ p_merchant_id: Number(process.env.TOSSPLACE_MERCHANT_ID), p_from: from, p_to: to, p_limit: limit }) });
    if (!response.ok) throw new Error(`Supabase menu sales read failed: ${response.status}`);
    return res.status(200).json({ ok: true, menus: await response.json(), filters: { from: req.query.from ?? null, to: req.query.to ?? null } });
  } catch (error) { console.error("Menu sales dashboard read failed", { message: error.message }); return res.status(502).json({ ok: false, error: "Menu sales data read failed" }); }
}
