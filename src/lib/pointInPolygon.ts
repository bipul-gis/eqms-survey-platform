/** Point-in-polygon helpers for zone geofencing (GeoJSON Polygon / MultiPolygon). */

type Ring = number[][];
type Position = [number, number];

export const ASSIGNED_ZONE_BUFFER_METERS = 50;

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

export type ZoneProximity<T> = {
  zone: T;
  inside: boolean;
  distanceMeters: number;
};

function distanceToSegmentMeters(
  lng: number,
  lat: number,
  start: number[],
  end: number[]
): number {
  if (
    start.length < 2 ||
    end.length < 2 ||
    !Number.isFinite(start[0]) ||
    !Number.isFinite(start[1]) ||
    !Number.isFinite(end[0]) ||
    !Number.isFinite(end[1])
  ) {
    return Number.POSITIVE_INFINITY;
  }

  // Local equirectangular projection is sufficiently accurate for a 50 m tolerance.
  const earthRadiusMeters = 6_371_008.8;
  const radians = Math.PI / 180;
  const longitudeScale = Math.cos(lat * radians);
  const toLocalMeters = (position: number[]): [number, number] => [
    (position[0] - lng) * radians * earthRadiusMeters * longitudeScale,
    (position[1] - lat) * radians * earthRadiusMeters,
  ];
  const [ax, ay] = toLocalMeters(start);
  const [bx, by] = toLocalMeters(end);
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function distanceToRingMeters(lng: number, lat: number, ring: Ring): number {
  if (ring.length < 2) return Number.POSITIVE_INFINITY;
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ring.length; i += 1) {
    nearest = Math.min(
      nearest,
      distanceToSegmentMeters(lng, lat, ring[i], ring[(i + 1) % ring.length])
    );
  }
  return nearest;
}

function distanceToGeometryBoundaryMeters(
  lng: number,
  lat: number,
  geometry: { type?: string; coordinates?: unknown } | null | undefined
): number {
  if (!geometry?.type || geometry.coordinates == null) return Number.POSITIVE_INFINITY;
  const polygons =
    geometry.type === 'Polygon'
      ? [geometry.coordinates as Ring[]]
      : geometry.type === 'MultiPolygon'
        ? (geometry.coordinates as Ring[][])
        : [];
  let nearest = Number.POSITIVE_INFINITY;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      nearest = Math.min(nearest, distanceToRingMeters(lng, lat, ring));
    }
  }
  return nearest;
}

/** Distance from a WGS84 point to a GeoJSON geometry in meters (zero if inside a polygon). */
export function distanceToGeometryMeters(
  lng: number,
  lat: number,
  geometry: { type?: string; coordinates?: unknown } | null | undefined
): number {
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || !geometry?.type || geometry.coordinates == null) {
    return Number.POSITIVE_INFINITY;
  }
  if (pointInGeometry(lng, lat, geometry)) return 0;
  if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
    return distanceToGeometryBoundaryMeters(lng, lat, geometry);
  }
  const coordinates = geometry.coordinates;
  const points: number[][] = [];
  const walk = (value: unknown) => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number' && typeof value[1] === 'number') points.push(value as number[]);
    else value.forEach(walk);
  };
  walk(coordinates);
  if (geometry.type === 'Point') {
    if (!points.length) return Number.POSITIVE_INFINITY;
    const earthRadiusMeters = 6_371_008.8;
    const radians = Math.PI / 180;
    const dLat = (points[0][1] - lat) * radians;
    const dLng = (points[0][0] - lng) * radians;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat * radians) * Math.cos(points[0][1] * radians) * Math.sin(dLng / 2) ** 2;
    return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  if (geometry.type === 'LineString' || geometry.type === 'MultiLineString' || geometry.type === 'MultiPoint') {
    if (geometry.type === 'MultiPoint' || geometry.type === 'LineString') {
      if (geometry.type === 'MultiPoint') return Math.min(...points.map((point) => distanceToSegmentMeters(lng, lat, point, point)));
      return points.length === 1 ? distanceToSegmentMeters(lng, lat, points[0], points[0]) : Math.min(...points.slice(1).map((point, index) => distanceToSegmentMeters(lng, lat, points[index], point)));
    }
    const lines = coordinates as unknown[];
    return Math.min(...lines.map((line) => {
      const linePoints: number[][] = [];
      const collect = (value: unknown) => {
        if (!Array.isArray(value)) return;
        if (typeof value[0] === 'number' && typeof value[1] === 'number') linePoints.push(value as number[]);
        else value.forEach(collect);
      };
      collect(line);
      return linePoints.length === 1 ? distanceToSegmentMeters(lng, lat, linePoints[0], linePoints[0]) : Math.min(...linePoints.slice(1).map((point, index) => distanceToSegmentMeters(lng, lat, linePoints[index], point)));
    }));
  }
  return Number.POSITIVE_INFINITY;
}

/** Finds an assigned zone containing the point or within the allowed distance outside its edge. */
export function findZoneWithinDistance<
  T extends { geometry: unknown; assignValue?: string | null },
>(lng: number, lat: number, zones: T[], maxDistanceMeters: number): ZoneProximity<T> | null {
  const containingZone = findContainingZone(lng, lat, zones);
  if (containingZone) {
    return { zone: containingZone, inside: true, distanceMeters: 0 };
  }

  let nearest: ZoneProximity<T> | null = null;
  for (const zone of zones) {
    const distanceMeters = distanceToGeometryBoundaryMeters(
      lng,
      lat,
      zone.geometry as { type?: string; coordinates?: unknown }
    );
    if (distanceMeters <= maxDistanceMeters && (!nearest || distanceMeters < nearest.distanceMeters)) {
      nearest = { zone, inside: false, distanceMeters };
    }
  }
  return nearest;
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
