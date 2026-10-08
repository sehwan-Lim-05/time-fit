import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

type Delivery = {
  delivery_id: string;
  subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth_secret: string;
  notification_id: string;
  title: string;
  body: string;
  deeplink_path: string;
  attempt_count: number;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

const allowedPath = (value: unknown) =>
  /^\/#(?:notifications|schedule|attendance|requests|approvals)(?:\?.*)?$/.test(String(value ?? ""))
    ? String(value)
    : "/#notifications";

const retryDelaySeconds = (attempt: number) => Math.min(3600, 30 * (2 ** Math.max(0, attempt - 1)));

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const dispatchSecret = Deno.env.get("SCHEDULE_PUSH_DISPATCH_SECRET");
  if (!dispatchSecret || request.headers.get("x-timefit-dispatch-secret") !== dispatchSecret) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const publicKey = Deno.env.get("WEB_PUSH_PUBLIC_KEY");
  const privateKey = Deno.env.get("WEB_PUSH_PRIVATE_KEY");
  const subject = Deno.env.get("WEB_PUSH_SUBJECT") ?? "mailto:support@timefit.kr";
  if (!url || !serviceKey || !publicKey || !privateKey) {
    return json({ ok: false, error: "server_configuration_missing" }, 503);
  }

  const client = createClient(url, serviceKey, { auth: { persistSession: false } });
  webpush.setVapidDetails(subject, publicKey, privateKey);

  const { data, error } = await client.rpc("timefit_user_claim_push_deliveries", { p_limit: 50 });
  if (error) return json({ ok: false, error: "delivery_claim_failed" }, 502);

  const deliveries = (data ?? []) as Delivery[];
  const summary = { ok: true, claimed: deliveries.length, sent: 0, retried: 0, dead: 0 };
  for (const delivery of deliveries) {
    try {
      await webpush.sendNotification({
        endpoint: delivery.endpoint,
        keys: { p256dh: delivery.p256dh, auth: delivery.auth_secret },
      }, JSON.stringify({
        title: delivery.title,
        body: delivery.body,
        tag: `timefit-${delivery.notification_id}`,
        deeplink: allowedPath(delivery.deeplink_path),
        notificationId: delivery.notification_id,
      }), { TTL: 3600, urgency: "normal" });

      await client.from("timefit_user_notification_deliveries").update({
        status: "sent",
        sent_at: new Date().toISOString(),
        provider_status: 201,
        last_error: null,
        lease_until: null,
        updated_at: new Date().toISOString(),
      }).eq("id", delivery.delivery_id);
      summary.sent += 1;
    } catch (caught) {
      const status = Number((caught as { statusCode?: number })?.statusCode ?? 0);
      const permanent = status === 404 || status === 410;
      if (permanent) {
        await client.from("timefit_user_mobile_push_subscriptions").update({
          revoked_at: new Date().toISOString(),
          revoked_reason: `provider_${status}`,
          updated_at: new Date().toISOString(),
        }).eq("id", delivery.subscription_id);
      }

      const exhausted = Number(delivery.attempt_count || 1) >= 5;
      const terminal = permanent || exhausted;
      await client.from("timefit_user_notification_deliveries").update({
        status: terminal ? "dead" : "retry_wait",
        available_at: terminal
          ? new Date().toISOString()
          : new Date(Date.now() + retryDelaySeconds(delivery.attempt_count) * 1000).toISOString(),
        provider_status: status || null,
        last_error: String((caught as Error)?.message || "push_failed").slice(0, 500),
        lease_until: null,
        updated_at: new Date().toISOString(),
      }).eq("id", delivery.delivery_id);
      if (terminal) summary.dead += 1;
      else summary.retried += 1;
    }
  }
  return json(summary);
});
