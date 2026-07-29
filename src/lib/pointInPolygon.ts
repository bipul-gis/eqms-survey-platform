/** Point-in-polygon helpers for zone geofencing (GeoJSON Polygon / MultiPolygon). */

type Ring = number[][];
type Position = [number, number];

function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  // Ray casting
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonCoords(lng: number, lat: number, coords: Ring[]): boolean {
  if (!coords.length) return false;
  if (!pointInRing(lng, lat, coords[0])) return false;
  // Holes
  for (let h = 1; h < coords.length; h++) {
    if (pointInRing(lng, lat, coords[h])) return false;
  }
  return true;
}

export function pointInGeometry(
  lng: number,
  lat: number,
  geometry: { type?: string; coordinates?: unknown } | null | undefined
): boolean {
  if (!geometry?.type || geometry.coordinates == null) return false;
  if (geometry.type === 'Polygon') {
    return pointInPolygonCoords(lng, lat, geometry.coordinates as Ring[]);
  }
  if (geometry.type === 'MultiPolygon') {
    const multi = geometry.coordinates as Ring[][];
    return multi.some((poly) => pointInPolygonCoords(lng, lat, poly));
  }
  return false;
}

export function findContainingZone<T extends { geometry: unknown; assignValue?: string | null }>(
  lng: number,
  lat: number,
  zones: T[]
): T | null {
  for (const z of zones) {
    if (pointInGeometry(lng, lat, z.geometry as { type?: string; coordinates?: unknown })) {
      return z;
    }
  }
  return null;
}

export function lngLatBoundsOfGeometry(
  geometry: { type?: string; coordinates?: unknown } | null | undefined
): { minLng: number; minLat: number; maxLng: number; maxLat: number } | null {
  const pts: Position[] = [];
  const walk = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      pts.push([c[0] as number, c[1] as number]);
      return;
    }
    for (const x of c) walk(x);
  };
  walk(geometry?.coordinates);
  if (!pts.length) return null;
  let minLng = pts[0][0];
  let maxLng = pts[0][0];
  let minLat = pts[0][1];
  let maxLat = pts[0][1];
  for (const [lng, lat] of pts) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLng, minLat, maxLng, maxLat };
}
