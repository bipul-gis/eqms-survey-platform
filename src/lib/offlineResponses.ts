/**
 * Offline response queue + read caches for enumerator field work.
 * Saves drafts/submissions to localStorage when the API is unreachable,
 * merges them into list reads, and flushes when connectivity returns.
 */

const PENDING_MANIFEST_KEY = 'geosurvey_offline_pending_responses_manifest';
const OFFLINE_QUEUE_DB_NAME = 'geosurvey_offline_queue';
const OFFLINE_QUEUE_STORE_NAME = 'pending_responses';
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
  _offlineOriginalStatus?: string;
};

let pendingQueueCache: OfflinePendingResponse[] = readPendingManifest();
let pendingQueueHydrated = false;
let pendingQueueLoadPromise: Promise<void> | null = null;

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

function cloneForManifest(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneForManifest(item));
  }
  if (!value || typeof value !== 'object') {
    if (
      typeof value === 'string' &&
      (value.startsWith('data:image') || value.startsWith('blob:'))
    ) {
      return { hasPhoto: true, fileName: 'photo.jpg' };
    }
    return value;
  }

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  let hadPhotoPayload = false;

  for (const [key, child] of Object.entries(input)) {
    if (key === 'dataUrl') {
      hadPhotoPayload = true;
      continue;
    }
    output[key] = cloneForManifest(child);
    if (key === 'fileName' || key === 'mimeType' || key === 'capturedAt' || key === 'source') {
      hadPhotoPayload = true;
    }
  }

  if (hadPhotoPayload && output.hasPhoto !== true && output._photo !== true) {
    output.hasPhoto = true;
  }

  return output;
}

export function normalizeResponseForCache(entry: Record<string, unknown>): Record<string, unknown> {
  return cloneForManifest(entry) as OfflinePendingResponse;
}

function normalizePendingResponse(entry: OfflinePendingResponse): OfflinePendingResponse {
  return normalizeResponseForCache(entry) as OfflinePendingResponse;
}

function mergePendingResponses(...lists: OfflinePendingResponse[][]): OfflinePendingResponse[] {
  const byId = new Map<string, OfflinePendingResponse>();
  for (const list of lists) {
    for (const item of list) {
      if (!item || typeof item.id !== 'string' || !item.id) continue;
      byId.set(item.id, item);
    }
  }
  return Array.from(byId.values());
}

function readPendingManifest(): OfflinePendingResponse[] {
  return readJson<OfflinePendingResponse[]>(PENDING_MANIFEST_KEY, []);
}

function writePendingManifest(entries: OfflinePendingResponse[]): void {
  writeJson(PENDING_MANIFEST_KEY, entries.map((entry) => normalizePendingResponse(entry)));
}

function setPendingQueue(entries: OfflinePendingResponse[], notify = true): void {
  pendingQueueCache = mergePendingResponses(entries);
  pendingQueueHydrated = true;
  writePendingManifest(pendingQueueCache);
  if (notify) notifyQueueChanged();
}

function indexedDbFactory(): IDBFactory | null {
  if (typeof window === 'undefined') return null;
  return window.indexedDB ?? null;
}

function openOfflineQueueDb(): Promise<IDBDatabase | null> {
  const factory = indexedDbFactory();
  if (!factory) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const request = factory.open(OFFLINE_QUEUE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OFFLINE_QUEUE_STORE_NAME)) {
        db.createObjectStore(OFFLINE_QUEUE_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open offline queue db'));
  });
}

async function readOfflineQueueDb(): Promise<OfflinePendingResponse[]> {
  const db = await openOfflineQueueDb();
  if (!db) return [];
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_QUEUE_STORE_NAME, 'readonly');
    const store = tx.objectStore(OFFLINE_QUEUE_STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      const items = Array.isArray(request.result) ? (request.result as OfflinePendingResponse[]) : [];
      resolve(items);
    };
    request.onerror = () => reject(request.error || new Error('Failed to read offline queue db'));
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('Failed to read offline queue db'));
    };
  });
}

async function persistOfflineQueueEntry(entry: OfflinePendingResponse): Promise<void> {
  const db = await openOfflineQueueDb();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(OFFLINE_QUEUE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(OFFLINE_QUEUE_STORE_NAME);
    store.put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to persist offline queue entry'));
    tx.onabort = () => reject(tx.error || new Error('Failed to persist offline queue entry'));
  }).finally(() => db.close());
}

async function deleteOfflineQueueEntry(id: string): Promise<void> {
  const db = await openOfflineQueueDb();
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(OFFLINE_QUEUE_STORE_NAME, 'readwrite');
    const store = tx.objectStore(OFFLINE_QUEUE_STORE_NAME);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to delete offline queue entry'));
    tx.onabort = () => reject(tx.error || new Error('Failed to delete offline queue entry'));
  }).finally(() => db.close());
}

async function hydratePendingQueue(): Promise<void> {
  if (pendingQueueLoadPromise) {
    await pendingQueueLoadPromise;
    return;
  }

  pendingQueueLoadPromise = (async () => {
    const manifest = readPendingManifest();
    pendingQueueCache = mergePendingResponses(pendingQueueCache, manifest);
    try {
      const persisted = await readOfflineQueueDb();
      if (persisted.length > 0) {
        pendingQueueCache = mergePendingResponses(pendingQueueCache, persisted);
      }
    } catch (e) {
      console.warn('offlineResponses: failed to hydrate indexed queue', e);
    }
    pendingQueueHydrated = true;
    writePendingManifest(pendingQueueCache);
  })();

  try {
    await pendingQueueLoadPromise;
  } finally {
    pendingQueueLoadPromise = null;
  }
}

function notifyQueueChanged(): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try {
    window.dispatchEvent(new Event('geosurvey:offline-queue-changed'));
  } catch {
    /* ignore */
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
  return pendingQueueHydrated ? pendingQueueCache : readPendingManifest();
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
  const originalStatus = typeof payload.status === 'string' ? payload.status : undefined;
  const entry: OfflinePendingResponse = {
    ...payload,
    id,
    status: originalStatus === 'submitted' ? 'queued' : originalStatus || 'draft',
    _offlineQueuedAt: new Date().toISOString(),
    _offlinePending: true,
    _offlineOriginalStatus: originalStatus
  };
  setPendingQueue([...getPendingResponses().filter((p) => p.id !== id), entry]);

  // Mirror into the responses cache so list/allocate see it immediately.
  const cached = getCachedResponses().filter((r) => String(r.id) !== id);
  cached.push(normalizePendingResponse(entry));
  cacheResponses(cached);

  return entry;
}

export async function persistQueuedResponse(entry: OfflinePendingResponse): Promise<void> {
  await persistOfflineQueueEntry(entry);
  await hydratePendingQueue();
  setPendingQueue([...getPendingResponses().filter((p) => p.id !== entry.id), entry], false);
}

export function removePendingResponse(id: string): void {
  const before = getPendingResponses();
  const next = before.filter((p) => p.id !== id);
  setPendingQueue(next, before.length !== next.length);
  void deleteOfflineQueueEntry(id).catch((e) =>
    console.warn('offlineResponses: failed to delete pending queue entry', id, e)
  );
}

export function cacheResponses(items: Record<string, unknown>[]): void {
  writeJson(
    RESPONSES_CACHE_KEY,
    items.map((item) => normalizeResponseForCache(item))
  );
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
    await hydratePendingQueue();
    const { geosurveyApi } = await import('./geosurveyApi');
    const pending = getPendingResponses();
    let flushed = 0;
    let failed = 0;
    for (const entry of pending) {
      const { _offlineQueuedAt, _offlinePending, _offlineOriginalStatus, ...payload } = entry;
      void _offlineQueuedAt;
      void _offlinePending;
      const originalStatus = typeof _offlineOriginalStatus === 'string' ? _offlineOriginalStatus : undefined;
      const uploadPayload = {
        ...payload,
        status: originalStatus || payload.status || 'submitted'
      } as Record<string, unknown>;
      try {
        const saved = await geosurveyApi.saveResponse(uploadPayload, { skipOfflineQueue: true });
        removePendingResponse(entry.id);
        const cached = getCachedResponses().filter((item) => String(item.id) !== String(entry.id));
        const savedId = typeof (saved as { id?: string }).id === 'string' ? (saved as { id?: string }).id : String(entry.id);
        cached.push({
          ...entry,
          ...saved,
          id: savedId,
          status: typeof (saved as { status?: unknown }).status === 'string'
            ? (saved as { status: string }).status
            : originalStatus || payload.status || 'submitted'
        });
        cacheResponses(cached);
        flushed += 1;
      } catch (e) {
        console.warn('offlineResponses: flush attempt failed', entry.id, e);
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
let offlineFlushTimer: number | null = null;

function tryFlushPendingResponses(reason: string): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  if (countPendingResponses() === 0) return;
  void flushOfflineResponseQueue().catch((e) =>
    console.warn(`offlineResponses: flush (${reason}) failed`, e)
  );
}

/** Attach once from app bootstrap — flushes queue when connectivity returns. */
export function ensureOfflineFlushListener(): void {
  if (typeof window === 'undefined' || onlineListenerAttached) return;
  onlineListenerAttached = true;

  void hydratePendingQueue().then(() => {
    if (navigator.onLine && countPendingResponses() > 0) {
      tryFlushPendingResponses('hydrate');
    }
  });

  const handleOnline = () => tryFlushPendingResponses('online');
  const handleVisible = () => {
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
      tryFlushPendingResponses('visible');
    }
  };

  window.addEventListener('online', handleOnline);
  window.addEventListener('focus', handleOnline);
  window.addEventListener('pageshow', handleOnline);

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisible);
  }

  if (offlineFlushTimer) {
    window.clearInterval(offlineFlushTimer);
  }
  offlineFlushTimer = window.setInterval(() => {
    if (typeof navigator !== 'undefined' && navigator.onLine !== false) {
      tryFlushPendingResponses('timer');
    }
  }, 5000);

  // Best-effort flush shortly after load if already online with leftovers.
  if (navigator.onLine && countPendingResponses() > 0) {
    window.setTimeout(() => {
      tryFlushPendingResponses('startup');
    }, 1500);
  }
}

export function resetOfflineResponsesForTests(): void {
  pendingQueueCache = [];
  pendingQueueHydrated = false;
  pendingQueueLoadPromise = null;
}
