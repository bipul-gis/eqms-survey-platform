/**
 * Offline response queue + read caches for enumerator field work.
 * Saves drafts/submissions to localStorage when the API is unreachable,
 * merges them into list reads, and flushes when connectivity returns.
 */

const PENDING_KEY = 'geosurvey_offline_pending_responses';
const RESPONSES_CACHE_KEY = 'geosurvey_cached_responses';
const QUESTIONNAIRES_CACHE_KEY = 'geosurvey_cached_questionnaires';
const PROFILE_CACHE_KEY = 'geosurvey_cached_auth_profile';

export type OfflinePendingResponse = Record<string, unknown> & {
  id: string;
  questionnaireId?: string;
  respondentId?: string;
  status?: string;
  _offlineQueuedAt?: string;
  _offlinePending?: true;
};

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readJson<T>(key: string, fallback: T): T {
  const store = storage();
  if (!store) return fallback;
  try {
    const raw = store.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('offlineResponses: localStorage write failed', e);
  }
}

export function isNetworkFailure(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (!(error instanceof Error)) return false;
  const msg = error.message || '';
  const name = error.name || '';
  return (
    name === 'TypeError' ||
    /failed to fetch/i.test(msg) ||
    /networkerror/i.test(msg) ||
    /network request failed/i.test(msg) ||
    /load failed/i.test(msg) ||
    /internet connection/i.test(msg)
  );
}

export function getPendingResponses(): OfflinePendingResponse[] {
  return readJson<OfflinePendingResponse[]>(PENDING_KEY, []);
}

export function countPendingResponses(): number {
  return getPendingResponses().length;
}

/** Upsert a response into the offline queue (create or update by id). */
export function enqueueOfflineResponse(
  payload: Record<string, unknown>
): OfflinePendingResponse {
  const id =
    typeof payload.id === 'string' && payload.id.trim()
      ? payload.id.trim()
      : `offline_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const entry: OfflinePendingResponse = {
    ...payload,
    id,
    _offlineQueuedAt: new Date().toISOString(),
    _offlinePending: true
  };
  const pending = getPendingResponses().filter((p) => p.id !== id);
  pending.push(entry);
  writeJson(PENDING_KEY, pending);

  // Mirror into the responses cache so list/allocate see it immediately.
  const cached = getCachedResponses().filter((r) => String(r.id) !== id);
  cached.push(entry);
  cacheResponses(cached);

  return entry;
}

export function removePendingResponse(id: string): void {
  writeJson(
    PENDING_KEY,
    getPendingResponses().filter((p) => p.id !== id)
  );
}

export function cacheResponses(items: Record<string, unknown>[]): void {
  writeJson(RESPONSES_CACHE_KEY, items);
}

export function getCachedResponses(): Record<string, unknown>[] {
  return readJson<Record<string, unknown>[]>(RESPONSES_CACHE_KEY, []);
}

export function cacheQuestionnaires(items: Record<string, unknown>[]): void {
  writeJson(QUESTIONNAIRES_CACHE_KEY, items);
}

export function getCachedQuestionnaires(): Record<string, unknown>[] {
  return readJson<Record<string, unknown>[]>(QUESTIONNAIRES_CACHE_KEY, []);
}

export function cacheAuthProfile(profile: unknown, token: string): void {
  writeJson(PROFILE_CACHE_KEY, { profile, token, at: Date.now() });
}

export function getCachedAuthProfile(): {
  profile: Record<string, unknown>;
  token: string;
  at: number;
} | null {
  const raw = readJson<{
    profile?: Record<string, unknown>;
    token?: string;
    at?: number;
  } | null>(PROFILE_CACHE_KEY, null);
  if (!raw?.profile?.uid || !raw.token) return null;
  return {
    profile: raw.profile,
    token: raw.token,
    at: typeof raw.at === 'number' ? raw.at : 0
  };
}

export function clearCachedAuthProfile(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(PROFILE_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

function matchesFilters(
  item: Record<string, unknown>,
  params?: { questionnaireId?: string; respondentId?: string; status?: string }
): boolean {
  if (!params) return true;
  if (params.questionnaireId && item.questionnaireId !== params.questionnaireId) return false;
  if (params.respondentId && item.respondentId !== params.respondentId) return false;
  if (params.status && item.status !== params.status) return false;
  return true;
}

/**
 * Merge server (or cached) items with offline pending writes.
 * Pending entries win on id conflict (they are newer local edits).
 */
export function mergeResponsesWithOffline(
  serverOrCached: Record<string, unknown>[],
  params?: { questionnaireId?: string; respondentId?: string; status?: string }
): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const item of serverOrCached) {
    const id = typeof item.id === 'string' ? item.id : '';
    if (!id) continue;
    byId.set(id, item);
  }
  for (const pending of getPendingResponses()) {
    byId.set(pending.id, pending);
  }
  return Array.from(byId.values()).filter((item) => matchesFilters(item, params));
}

let flushInFlight: Promise<{ flushed: number; failed: number }> | null = null;

/**
 * Push queued responses to the server. Safe to call repeatedly.
 * Uses a dynamic import of geosurveyApi to avoid circular init issues.
 */
export async function flushOfflineResponseQueue(): Promise<{
  flushed: number;
  failed: number;
}> {
  if (flushInFlight) return flushInFlight;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { flushed: 0, failed: countPendingResponses() };
  }

  flushInFlight = (async () => {
    const { geosurveyApi } = await import('./geosurveyApi');
    const pending = getPendingResponses();
    let flushed = 0;
    let failed = 0;
    for (const entry of pending) {
      const { _offlineQueuedAt, _offlinePending, ...payload } = entry;
      void _offlineQueuedAt;
      void _offlinePending;
      try {
        await geosurveyApi.saveResponse(payload, { skipOfflineQueue: true });
        removePendingResponse(entry.id);
        flushed += 1;
      } catch (e) {
        if (isNetworkFailure(e)) {
          failed = pending.length - flushed;
          break;
        }
        // Non-network failures (validation, auth, server-side issues) should stay queued
        // so the enumerator can retry later instead of silently losing the submission.
        console.warn('offlineResponses: keeping failed pending item for retry', entry.id, e);
        failed += 1;
      }
    }
    return { flushed, failed };
  })();

  try {
    return await flushInFlight;
  } finally {
    flushInFlight = null;
  }
}

let onlineListenerAttached = false;

/** Attach once from app bootstrap — flushes queue when connectivity returns. */
export function ensureOfflineFlushListener(): void {
  if (typeof window === 'undefined' || onlineListenerAttached) return;
  onlineListenerAttached = true;
  window.addEventListener('online', () => {
    void flushOfflineResponseQueue().catch((e) =>
      console.warn('offlineResponses: flush on reconnect failed', e)
    );
  });
  // Best-effort flush shortly after load if already online with leftovers.
  if (navigator.onLine && countPendingResponses() > 0) {
    window.setTimeout(() => {
      void flushOfflineResponseQueue().catch(() => undefined);
    }, 1500);
  }
}
