import { useEffect, useState } from 'react';
import { fetchLandmarkGeoJson } from '../lib/landmarkGeoJson';

export type LandmarkGeoJsonPoint = {
  lat: number;
  lng: number;
  properties: Record<string, any>;
};

let cache: LandmarkGeoJsonPoint[] | null = null;
let inflight: Promise<LandmarkGeoJsonPoint[]> | null = null;

async function loadPoints(): Promise<LandmarkGeoJsonPoint[]> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const resp = await fetchLandmarkGeoJson();
    if (!resp.ok) throw new Error(String(resp.status));
    const geo = await resp.json();
    const points = Array.isArray(geo?.features)
      ? geo.features
          .filter((f: any) => f?.geometry?.type === 'Point' && Array.isArray(f?.geometry?.coordinates))
          .map((f: any) => ({
            lat: f.geometry.coordinates[1],
            lng: f.geometry.coordinates[0],
            properties: f.properties || {}
          }))
      : [];
    cache = points;
    return points;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/**
 * Landmark reference points from bundled GeoJSON (map overlay).
 * @param refreshKey — When this changes (e.g. admin "Refresh map data"), cache is dropped and data is re-fetched.
 */
export function useLandmarkGeoJsonPoints(refreshKey = 0): LandmarkGeoJsonPoint[] {
  const [points, setPoints] = useState<LandmarkGeoJsonPoint[]>(() => cache ?? []);

  useEffect(() => {
    let mounted = true;
    cache = null;
    inflight = null;
    void loadPoints().then((pts) => {
      if (mounted) setPoints(pts);
    });
    return () => {
      mounted = false;
    };
  }, [refreshKey]);

  return points;
}
