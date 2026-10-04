// Fetch the entire fixed payment-change window before publishing any orders.
export async function collectOrderPages({ url, headers, from, to, size = 500, deadline = Date.now() + 45000, read = fetch }) {
  const orders = new Map();
  for (let page = 1; page <= 200; page++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Sales sync time limit exceeded; retry with a smaller window');
    const params = new URLSearchParams({ page: String(page), size: String(size), sortOrder: 'ASC', to });
    if (from) params.set('from', from);
    const response = await read(`${url}?${params}`, { headers, signal: AbortSignal.timeout(remaining) });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.resultType !== 'SUCCESS') {
      if (response.status === 401) throw new Error('Toss Place 인증에 실패했습니다. Access Key·Secret을 확인해 주세요.');
      throw new Error(`Toss Place 주문 조회 실패 (${response.status})`);
    }
    if (!Array.isArray(body.success)) throw new Error('Invalid Toss Place order response');
    for (const order of body.success) {
      if (!order?.id || !Number.isFinite(Date.parse(order.createdAt ?? order.orderedAt))) throw new Error('Invalid Toss Place order record');
      orders.set(String(order.id), order);
    }
    if (body.success.length < size) return [...orders.values()];
  }
  throw new Error('Sales sync page limit exceeded; incomplete data was not published');
}
