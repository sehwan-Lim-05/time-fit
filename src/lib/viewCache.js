// Short-lived, in-memory snapshots for navigating between manager screens.
// The caller must include both the signed-in account and organization in each key.
const snapshots = new Map();
const MAX_ENTRIES = 40;
const TTL_MS = 30_000;

export function readViewCache(key, now = Date.now(), ttlMs = TTL_MS) {
  const snapshot = key && snapshots.get(key);
  if (!snapshot) return null;
  if (now - snapshot.savedAt >= ttlMs) { snapshots.delete(key); return null; }
  return snapshot.data;
}

export function writeViewCache(key, data, now = Date.now()) {
  if (!key) return;
  snapshots.delete(key);
  snapshots.set(key, { data, savedAt: now });
  if (snapshots.size > MAX_ENTRIES) snapshots.delete(snapshots.keys().next().value);
}

export function invalidateViewCache(prefix = '') {
  for (const key of snapshots.keys()) if (key.startsWith(prefix)) snapshots.delete(key);
}
