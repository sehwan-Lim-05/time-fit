// Toss Place webhook receiver. It never alters Toss orders or payments.
// Full payloads are intentionally not logged because they can contain customer data.
export default function handler(req, res) {
  if (req.method === "GET") return res.status(200).json({ ok: true, service: "timefit-tossplace-webhook" });
  if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return res.status(405).json({ ok: false, error: "Method not allowed" }); }
  const payload = req.body ?? {}, eventData = payload.data ?? {}, order = eventData.order ?? payload.order ?? {}, payment = eventData.payment ?? payload.payment ?? {};
  console.info("Toss Place webhook received", { eventType: payload.eventType ?? payload.type ?? payload.event?.type ?? "unknown", receivedAt: new Date().toISOString(), merchantId: payload.merchantId ?? order.merchantId ?? payment.merchantId ?? null, orderId: order.id ?? payment.orderId ?? payload.orderId ?? null, paymentId: payment.id ?? payload.paymentId ?? null });
  return res.status(200).json({ ok: true });
}
