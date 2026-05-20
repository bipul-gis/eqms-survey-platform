/** Short-lived in-memory cache to avoid duplicate Firestore reads during field work. */

const store = new Map<string, { at: number; data: unknown }>();

export function getCached<T>(key: string, ttlMs: number): T | null {
  const entry = store.get(key);
  if (!entry || Date.now() - entry.at > ttlMs) return null;
  return entry.data as T;
}

export function setCached(key: string, data: unknown): void {
  store.set(key, { at: Date.now(), data });
}

/** Drop entries whose key equals `key` or starts with `prefix:`. */
export function invalidateCached(keyOrPrefix: string): void {
  for (const k of store.keys()) {
    if (k === keyOrPrefix || k.startsWith(`${keyOrPrefix}:`)) {
      store.delete(k);
    }
  }
}
