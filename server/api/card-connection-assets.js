import { authorizeFinance, financeError, financeRest, financeServerConfigured, methodNotAllowed } from './_finance-server.js';
import { cardProvider } from './providers/card-provider.js';

async function connectionForOwner(req, organizationId, connectionId) {
  const auth = await authorizeFinance(req, organizationId, { ownerOnly: true });
  if (!auth) return null;
  const rows = await financeRest(`timefit_user_card_connections?id=eq.${encodeURIComponent(connectionId)}&organization_id=eq.${encodeURIComponent(organizationId)}&select=*`);
  return rows[0] ? { auth, connection: rows[0] } : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  if (!financeServerConfigured()) return res.status(503).json({ ok: false, error: '금융 연결 서버 설정이 필요합니다.' });
  const { organizationId, connectionId, action = 'discover', assetIds = [] } = req.body || {};
  try {
    const context = await connectionForOwner(req, organizationId, connectionId);
    if (!context) return res.status(req.headers.authorization ? 403 : 401).json({ ok: false, error: '조직 소유자 인증이 필요합니다.' });
    const provider = cardProvider(context.connection.provider, context.connection);
    if (action === 'discover') {
      const cards = await provider.listCards();
      const payload = cards.map(card => ({ organization_id: organizationId, connection_id: connectionId, provider_asset_id: card.providerAssetId, display_name: card.displayName, last4: card.last4, status: 'discovered' }));
      const assets = await financeRest('timefit_user_connection_assets?on_conflict=connection_id,provider_asset_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(payload) });
      return res.status(200).json({ ok: true, assets });
    }
    if (action !== 'select' || !Array.isArray(assetIds) || !assetIds.length) return res.status(400).json({ ok: false, error: '선택할 카드를 확인해 주세요.' });
    const assets = await financeRest(`timefit_user_connection_assets?connection_id=eq.${encodeURIComponent(connectionId)}&id=in.(${assetIds.map(encodeURIComponent).join(',')})&select=*`);
    const providerCards = await provider.listCards();
    const selected = [];
    for (const asset of assets) {
      const providerCard = providerCards.find(card => card.providerAssetId === asset.provider_asset_id);
      if (!providerCard) continue;
      let cards = await financeRest(`timefit_user_corporate_cards?organization_id=eq.${encodeURIComponent(organizationId)}&provider=eq.${encodeURIComponent(context.connection.provider)}&provider_card_id=eq.${encodeURIComponent(providerCard.providerAssetId)}&select=*`);
      if (!cards.length) cards = await financeRest('timefit_user_corporate_cards', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{ organization_id: organizationId, connection_id: connectionId, issuer: providerCard.issuer, nickname: providerCard.displayName, last4: providerCard.last4, status: 'active', provider: context.connection.provider, provider_card_id: providerCard.providerAssetId, created_by: context.auth.user.id }]) });
      const card = cards[0];
      await financeRest(`timefit_user_connection_assets?id=eq.${encodeURIComponent(asset.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ corporate_card_id: card.id, status: 'selected', updated_at: new Date().toISOString() }) });
      selected.push(card);
    }
    await financeRest(`timefit_user_card_connections?id=eq.${encodeURIComponent(connectionId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'backfilling', updated_at: new Date().toISOString() }) });
    return res.status(200).json({ ok: true, cards: selected });
  } catch (error) {
    return financeError(res, error, '카드 목록을 처리하지 못했습니다.');
  }
}
