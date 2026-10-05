import { useEffect, useState } from 'react';
import { geosurveyApi } from '../lib/geosurveyApi';
import type { GeoFeature, FeatureStatus } from '../types';

export type FeaturesLoadMode = 'idle' | 'admin' | 'enumerator';
export type FeatureSyncState = {
  online: boolean;
  hasPendingWrites: boolean;
  fromCache: boolean;
};

const FEATURE_CACHE_DB = 'geosurvey_feature_cache';
const FEATURE_CACHE_STORE = 'scopes';

function openFeatureCache(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(FEATURE_CACHE_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(FEATURE_CACHE_STORE)) {
        request.result.createObjectStore(FEATURE_CACHE_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function readFeatureCache(key: string): Promise<GeoFeature[]> {
  const db = await openFeatureCache();
  if (!db) return [];
  return new Promise((resolve) => {
    const request = db.transaction(FEATURE_CACHE_STORE, 'readonly').objectStore(FEATURE_CACHE_STORE).get(key);
    request.onsuccess = () => {
      const result = request.result?.features;
      resolve(Array.isArray(result) ? result as GeoFeature[] : []);
      db.close();
    };
    request.onerror = () => { db.close(); resolve([]); };
  });
}

async function writeFeatureCache(key: string, features: GeoFeature[]): Promise<void> {
  const db = await openFeatureCache();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(FEATURE_CACHE_STORE, 'readwrite');
    tx.objectStore(FEATURE_CACHE_STORE).put({ key, features, savedAt: Date.now() });
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); resolve(); };
    tx.onabort = () => { db.close(); resolve(); };
  });
}

function normalizeFeatureStatus(raw: unknown): FeatureStatus {
  if (raw === 'verified' || raw === 'rejected' || raw === 'pending') return raw;
  return 'pending';
}

function toGeoFeature(raw: Record<string, unknown>): GeoFeature {
  return {
    ...(raw as unknown as GeoFeature),
    id: String(raw.id),
    status: normalizeFeatureStatus(raw.status),
  };
}

export function useOptimizedFeatures(options: {
  mode: FeaturesLoadMode;
  projectId?: string;
  /** Load all project-wide uploaded layers assigned to a geospatial enumerator. */
  projectIds?: string[];
  userUid: string | undefined;
  userEmail: string | undefined;
  assignedWards: string[];
  adminRefreshKey: number;
  enumeratorPersistRefreshKey: number;
}) {
  const [features, setFeatures] = useState<GeoFeature[]>([]);
  const [loading, setLoading] = useState(true);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [syncState, setSyncState] = useState<FeatureSyncState>({
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    hasPendingWrites: false,
    fromCache: false,
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const updateOnline = () => {
      setSyncState((prev) => ({ ...prev, online: navigator.onLine }));
    };
    updateOnline();
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    return () => {
      window.removeEventListener('online', updateOnline);
      window.removeEventListener('offline', updateOnline);
    };
  }, []);

  useEffect(() => {
    if (options.mode === 'idle') {
      setFeatures([]);
      setLoading(false);
      setInitialLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setInitialLoading(true);
    const projectIds = [...new Set((options.projectIds || []).filter(Boolean))].sort();
    const cacheKey = [
      options.mode,
      projectIds.length ? projectIds.join(',') : options.projectId || 'all',
      options.userUid || '',
      options.assignedWards.join(','),
    ].join(':');
    const hideBlockingLoader = window.setTimeout(() => {
      if (!cancelled) setInitialLoading(false);
    }, 1800);
    let networkLoaded = false;
    let lastCacheSignature = '';
    if (options.mode === 'enumerator') {
      void readFeatureCache(cacheKey).then((cached) => {
        if (cancelled || networkLoaded || cached.length === 0) return;
        lastCacheSignature = cached.map((feature) => `${feature.id}:${feature.updatedAt || ''}`).join('|');
        setFeatures(cached);
        setSyncState((prev) => ({ ...prev, fromCache: true }));
        setInitialLoading(false);
      });
    }
    const load = async () => {
      try {
        setLoading(true);
        const requests = projectIds.length
          ? projectIds.map((projectId) => geosurveyApi.listFeatures({ projectId }))
          : [geosurveyApi.listFeatures({ projectId: options.projectId })];
        const settled = await Promise.allSettled(requests);
        const responses = settled.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof geosurveyApi.listFeatures>>> => result.status === 'fulfilled').map((result) => result.value);
        if (!responses.length && settled.some((result) => result.status === 'rejected')) {
          const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
          throw failure?.reason || new Error('Could not load survey map data.');
        }
        if (cancelled) return;
        const freshFeatures = [...new Map(responses.flatMap((response) => response.items).map((item) => [String(item.id), toGeoFeature(item)])).values()];
        networkLoaded = true;
        setFeatures(freshFeatures);
        if (options.mode === 'enumerator') {
          const signature = freshFeatures.map((feature) => `${feature.id}:${feature.updatedAt || ''}`).join('|');
          if (signature !== lastCacheSignature) {
            lastCacheSignature = signature;
            void writeFeatureCache(cacheKey, freshFeatures);
          }
        }
        setSyncState((prev) => ({ ...prev, hasPendingWrites: false, fromCache: false }));
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setInitialLoading(false);
          window.clearTimeout(hideBlockingLoader);
        }
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), 15_000);
    const reloadOnline = () => void load();
    window.addEventListener('online', reloadOnline);
    return () => {
      cancelled = true;
      window.clearTimeout(hideBlockingLoader);
      window.clearInterval(interval);
      window.removeEventListener('online', reloadOnline);
    };
  }, [
    options.mode,
    options.projectId,
    options.projectIds?.join('|'),
    options.userUid,
    options.userEmail,
    options.assignedWards.join('|'),
    options.adminRefreshKey,
    options.enumeratorPersistRefreshKey,
  ]);

  return { features, loading, initialLoading, error, syncState };
}
