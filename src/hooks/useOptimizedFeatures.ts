import { useEffect, useState } from 'react';
import {
  collection,
  query,
  where,
  onSnapshot,
  getDocs,
  type Query
} from 'firebase/firestore';
import { db } from '../lib/firebase';
import type { GeoFeature, FeatureStatus } from '../types';
import { parseWardNumber } from '../lib/wardGeometry';

export type FeaturesLoadMode = 'idle' | 'admin' | 'enumerator';

function normalizeFeatureStatus(raw: unknown): FeatureStatus {
  if (raw === 'verified' || raw === 'rejected' || raw === 'pending') return raw;
  return 'pending';
}

function docToGeoFeature(docSnap: { id: string; data: () => Record<string, unknown> }): GeoFeature {
  const data = docSnap.data();
  return { id: docSnap.id, ...data, status: normalizeFeatureStatus(data.status) } as GeoFeature;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Firestore `in` matches type strictly — include both `"4"` and `4`. */
function expandAssignedWardsForInQuery(wards: string[]): (string | number)[] {
  const out: (string | number)[] = [];
  const dedupe = new Set<string>();
  for (const w of wards) {
    const s = String(w).trim();
    if (!s) continue;
    if (!dedupe.has(`s:${s}`)) {
      dedupe.add(`s:${s}`);
      out.push(s);
    }
    const n = parseWardNumber(s);
    if (n !== null && !dedupe.has(`n:${n}`)) {
      dedupe.add(`n:${n}`);
      out.push(n);
    }
  }
  return out;
}

/**
 * Admin: one `getDocs` per mount / refresh — no realtime listener (fewer reads).
 *
 * Enumerator with assigned wards: realtime on `attributes.__taskWard` (immutable task ward from landmark import)
 * and legacy `attributes.Ward_Name` (chunked `in`, max 10 values per query). Merged by document id.
 *
 * Enumerator without wards yet: `createdByUid` / `createdBy` only until admin assigns wards.
 */
export function useOptimizedFeatures(options: {
  mode: FeaturesLoadMode;
  userUid: string | undefined;
  userEmail: string | undefined;
  assignedWards: string[];
  adminRefreshKey: number;
  /** Bump after a feature is saved so enumerator listeners re-sync (admin uses adminRefreshKey). */
  enumeratorPersistRefreshKey: number;
}) {
  const [features, setFeatures] = useState<GeoFeature[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (options.mode !== 'idle') return;
    setFeatures([]);
    setLoading(false);
    setError(null);
  }, [options.mode]);

  useEffect(() => {
    if (options.mode !== 'admin') return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const snap = await getDocs(collection(db, 'features'));
        if (cancelled) return;
        setFeatures(snap.docs.map((d) => docToGeoFeature(d)));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [options.mode, options.adminRefreshKey]);

  const wardsKey = [...options.assignedWards].sort().join('|');

  useEffect(() => {
    if (options.mode !== 'enumerator') return;
    if (!options.userUid) {
      setFeatures([]);
      setLoading(false);
      return;
    }

    setFeatures([]);
    setLoading(true);
    setError(null);

    const maps = new Map<string, Map<string, GeoFeature>>();

    const recompute = () => {
      const byId = new Map<string, GeoFeature>();
      maps.forEach((m) => m.forEach((f, id) => byId.set(id, f)));
      setFeatures(Array.from(byId.values()));
      setLoading(false);
    };

    const subscribe = (key: string, q: Query) => {
      maps.set(key, new Map());
      return onSnapshot(
        q,
        (snap) => {
          const m = new Map<string, GeoFeature>();
          snap.forEach((docSnap) => {
            m.set(docSnap.id, docToGeoFeature(docSnap));
          });
          maps.set(key, m);
          recompute();
        },
        (err) => {
          setError(err);
          setLoading(false);
        }
      );
    };

    const unsubs: (() => void)[] = [];
    const assigned = options.assignedWards.map((w) => String(w).trim()).filter(Boolean);

    if (assigned.length === 0) {
      unsubs.push(
        subscribe(
          'ownUid',
          query(collection(db, 'features'), where('createdByUid', '==', options.userUid))
        )
      );
      const email = options.userEmail?.trim();
      if (email) {
        unsubs.push(
          subscribe(
            'ownEmail',
            query(collection(db, 'features'), where('createdBy', '==', email))
          )
        );
      }
    } else {
      const inValues = expandAssignedWardsForInQuery(assigned);
      const wardChunks = chunkArray(inValues, 10);
      wardChunks.forEach((chunk, idx) => {
        if (chunk.length === 0) return;
        unsubs.push(
          subscribe(
            `wardTask_${idx}`,
            query(collection(db, 'features'), where('attributes.__taskWard', 'in', chunk))
          )
        );
        unsubs.push(
          subscribe(
            `wardLegacy_${idx}`,
            query(collection(db, 'features'), where('attributes.Ward_Name', 'in', chunk))
          )
        );
      });
    }

    return () => {
      unsubs.forEach((u) => u());
      maps.clear();
    };
  }, [options.mode, options.userUid, options.userEmail, wardsKey, options.enumeratorPersistRefreshKey]);

  return { features, loading, error };
}
