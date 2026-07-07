import { useEffect, useState } from 'react';
import { geosurveyApi } from '../lib/geosurveyApi';
import type { GeoFeature, FeatureStatus } from '../types';

export type FeaturesLoadMode = 'idle' | 'admin' | 'enumerator';
export type FeatureSyncState = {
  online: boolean;
  hasPendingWrites: boolean;
  fromCache: boolean;
};

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
  userUid: string | undefined;
  userEmail: string | undefined;
  assignedWards: string[];
  adminRefreshKey: number;
  enumeratorPersistRefreshKey: number;
}) {
  const [features, setFeatures] = useState<GeoFeature[]>([]);
  const [loading, setLoading] = useState(true);
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
      setError(null);
      return;
    }

    let cancelled = false;
    const load = async () => {
      try {
        setLoading(true);
        const res = await geosurveyApi.listFeatures();
        if (cancelled) return;
        setFeatures(res.items.map((item) => toGeoFeature(item)));
        setSyncState((prev) => ({ ...prev, hasPendingWrites: false, fromCache: false }));
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    options.mode,
    options.userUid,
    options.userEmail,
    options.assignedWards.join('|'),
    options.adminRefreshKey,
    options.enumeratorPersistRefreshKey,
  ]);

  return { features, loading, error, syncState };
}
