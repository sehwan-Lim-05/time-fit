// Durable collection; raw sales are published only after the last page.
export async function advanceSalesJob({ organizationId, merchantId, backfill, headers, headersForJob, url,
  normalize, rpc, deadline, read = fetch, now = Date.now, maxPages = 20 }) {
  const job = await rpc('timefit_user_claim_sales_job', {
    p_organization_id: organizationId, p_merchant_id: Number(merchantId), p_backfill: backfill,
  });
  if (job.busy) return { status: 'running', synchronized: 0 };
  const identity = { p_job_id: job.id, p_run_token: job.run_token };
  try {
    // Use the credential snapshot captured when the DB grants the lease, not
    // an earlier connection-list read. Changes during collection fail at finish.
    if (headersForJob) headers = headersForJob(job);
    let ready = job.status === 'ready';
    let page = job.next_page;
    for (let i = 0; !ready && i < maxPages && deadline - now() > 1500; i++, page++) {
      const params = new URLSearchParams({ page: String(page), size: '500', sortOrder: 'ASC', to: job.window_to });
      if (job.window_from) params.set('from', job.window_from);
      const response = await read(`${url}?${params}`, { headers, signal: AbortSignal.timeout(Math.max(1, deadline - now() - 1000)) });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.resultType !== 'SUCCESS') throw new Error(`Toss Place 주문 조회 실패 (${response.status})`);
      if (!Array.isArray(body.success) || body.success.length > 500) throw new Error('Invalid Toss Place order response');
      const rows = body.success.map(order => {
        if (!order?.id || !Number.isFinite(Date.parse(order.createdAt ?? order.orderedAt))) throw new Error('Invalid Toss Place order record');
        return normalize(order);
      });
      const unique = [...new Map(rows.map(row => [row.order_id, row])).values()];
      ready = body.success.length < 500;
      await rpc('timefit_user_stage_sales_page', { ...identity, p_page: page, p_orders: unique, p_complete: ready });
    }
    if (ready && deadline - now() > 1000) {
      const count = await rpc('timefit_user_finish_sales_job', identity);
      return { status: 'completed', synchronized: Number(count) };
    }
    await rpc('timefit_user_release_sales_job', { ...identity, p_error: null });
    return { status: 'pending', synchronized: 0 };
  } catch (error) {
    if (error.name === 'TimeoutError') {
      await rpc('timefit_user_release_sales_job', { ...identity, p_error: null }).catch(() => {});
      return { status: 'pending', synchronized: 0 };
    }
    // Token-conditional release also handles completion with a lost response.
    await rpc('timefit_user_release_sales_job', { ...identity, p_error: error.message }).catch(() => {});
    throw error;
  }
}
