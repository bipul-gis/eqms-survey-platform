import { useEffect, useState } from 'react';
import landmarkGeoJsonUrl from '../data/CCC_all_Landmark.geojson?url';

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
    const resp = await fetch(landmarkGeoJsonUrl);
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

/** Cached landmark reference points (same file as the map layer). */
export function useLandmarkGeoJsonPoints(): LandmarkGeoJsonPoint[] {
  const [points, setPoints] = useState<LandmarkGeoJsonPoint[]>(() => cache ?? []);

  useEffect(() => {
    let mounted = true;
    void loadPoints().then((pts) => {
      if (mounted) setPoints(pts);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return points;
}
