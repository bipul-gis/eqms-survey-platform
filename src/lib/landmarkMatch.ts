import type { GeoFeature } from '../types';

export function normalizeLandmarkFid(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : undefined;
}

export function fidsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const na = normalizeLandmarkFid(a);
  const nb = normalizeLandmarkFid(b);
  if (na === undefined || nb === undefined) return false;
  return na === nb;
}

/** Same rule as MapComponent: match GeoJSON point to Firestore point by FID or exact coordinates. */
export function findMatchingFirestoreLandmark(
  p: { lat: number; lng: number; properties: Record<string, any> },
  features: GeoFeature[]
): GeoFeature | undefined {
  const fid = normalizeLandmarkFid(p.properties?.FID);
  return features.find((f) => {
    if (f.type !== 'point') return false;
    if (fid !== undefined) return fidsEqual(f.attributes?.FID, fid);
    if (!Array.isArray(f.geometry?.coordinates)) return false;
    return (
      Math.abs((f.geometry.coordinates[1] ?? 0) - p.lat) < 0.0000001 &&
      Math.abs((f.geometry.coordinates[0] ?? 0) - p.lng) < 0.0000001
    );
  });
}
