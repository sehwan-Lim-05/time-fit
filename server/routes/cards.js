import cardConnectionAssets from '../api/card-connection-assets.js';
import cardConnectionHistory from '../api/card-connection-history.js';
import cardConnectionReauth from '../api/card-connection-reauth.js';
import cardConnections from '../api/card-connections.js';
import cardSync from '../api/card-sync.js';
import cardSyncWorker from '../api/card-sync-worker.js';

export const cardRoutes = Object.freeze({
  'card-connection-assets': cardConnectionAssets,
  'card-connection-history': cardConnectionHistory,
  'card-connection-reauth': cardConnectionReauth,
  'card-connections': cardConnections,
  'card-sync': cardSync,
  'card-sync-worker': cardSyncWorker,
});
