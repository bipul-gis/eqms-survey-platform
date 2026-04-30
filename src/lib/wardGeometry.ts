import type { GeoFeature, UserProfile } from '../types';

/** Lowercase trimmed key for ward label comparisons */
export const normalizeWardKey = (s: string) => s.trim().toLowerCase();

/**
 * Extract ward index from labels like "4", "04", "Ward 04", "WARD 12" for cross-format matching.
 */
export function parseWardNumber(label: string): number | null {
  const s = String(label).trim();
  if (!s) return null;
  const m = s.match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isFinite(n) ? n : null;
}

/** Same ward whether stored as number `4` on the landmark or assigned as `Ward 04` in admin UI. */
export function wardIdentifiersMatch(a: string, b: string): boolean {
  if (normalizeWardKey(a) === normalizeWardKey(b)) return true;
  const na = parseWardNumber(a);
  const nb = parseWardNumber(b);
  if (na !== null && nb !== null && na === nb) return true;
  return false;
}

export function wardMatchesAssignedList(featureWardLabel: string, assigned: string[]): boolean {
  return assigned.some((w) => wardIdentifiersMatch(featureWardLabel, w));
}

/** Normalized list of admin-assigned wards on a user profile. */
export function assignedWardsFromUserProfile(
  data: Pick<UserProfile, 'assignedWardNames' | 'assignedWardName'>
): string[] {
  const list = data.assignedWardNames;
  if (Array.isArray(list) && list.length > 0) {
    return [...new Set(list.map((w) => String(w).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }
  const legacy = data.assignedWardName;
  if (typeof legacy === 'string' && legacy.trim()) return [legacy.trim()];
  return [];
}

/** Treat missing / placeholder ward attributes as unusable (GeoJSON often has Ward_Name: 0). */
export const isTrivialWardValue = (v: unknown): boolean => {
  if (v === null || v === undefined) return true;
  if (typeof v === 'number' && (v === 0 || !Number.isFinite(v))) return true;
  const s = String(v).trim();
  return s === '' || s === '0';
};

export const wardLabelFromAttributes = (attrs: Record<string, any> | undefined): string => {
  if (!attrs) return '';
  const v = attrs.Ward_Name ?? attrs.WARDNAME ?? attrs.WardName;
  if (isTrivialWardValue(v)) return '';
  return String(v).trim();
};

function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  if (!ring || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonCoords(lng: number, lat: number, coordinates: number[][][]): boolean {
  const outer = coordinates[0];
  if (!outer || !pointInRing(lng, lat, outer)) return false;
  for (let i = 1; i < coordinates.length; i++) {
    const hole = coordinates[i];
    if (hole && pointInRing(lng, lat, hole)) return false;
  }
  return true;
}

function pointInMultiPolygon(lng: number, lat: number, coordinates: number[][][][]): boolean {
  for (const poly of coordinates) {
    if (pointInPolygonCoords(lng, lat, poly)) return true;
  }
  return false;
}

/**
 * Ward polygon label (e.g. WARDNAME) for a lng/lat inside `ccc_wards` GeoJSON.
 */
export function getWardNameForLngLat(
  lng: number,
  lat: number,
  wards: { features?: Array<{ geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> }> }
): string | null {
  for (const feat of wards?.features || []) {
    const g = feat.geometry;
    const props = feat.properties || {};
    const name = String(props.WARDNAME ?? props.Ward_Name ?? '').trim();
    if (!name) continue;

    if (g?.type === 'Polygon' && Array.isArray(g.coordinates)) {
      if (pointInPolygonCoords(lng, lat, g.coordinates as number[][][])) return name;
    } else if (g?.type === 'MultiPolygon' && Array.isArray(g.coordinates)) {
      if (pointInMultiPolygon(lng, lat, g.coordinates as number[][][][])) return name;
    }
  }
  return null;
}

function representativeLngLat(geometry: { type?: string; coordinates?: unknown }): [number, number] | null {
  const t = geometry?.type;
  const c = geometry?.coordinates as any;
  if (t === 'Point' && Array.isArray(c) && c.length >= 2) {
    const lng = Number(c[0]);
    const lat = Number(c[1]);
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
  }
  if (t === 'LineString' && Array.isArray(c) && c[0] && Array.isArray(c[0])) {
    const lng = Number(c[0][0]);
    const lat = Number(c[0][1]);
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
  }
  if (t === 'Polygon' && Array.isArray(c) && c[0] && Array.isArray(c[0]) && c[0][0]) {
    const ring = c[0];
    const lng = Number(ring[0][0]);
    const lat = Number(ring[0][1]);
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
  }
  return null;
}

/**
 * Effective ward label for filtering: use attributes when meaningful, else point-in-polygon vs ward boundaries.
 */
export function effectiveWardLabelForFeature(
  f: GeoFeature,
  wards: { features?: unknown[] } | null | undefined
): string | null {
  const fromAttrs = wardLabelFromAttributes(f.attributes);
  if (fromAttrs) return fromAttrs;

  if (!wards?.features?.length) return null;
  const ll = representativeLngLat(f.geometry);
  if (!ll) return null;
  return getWardNameForLngLat(ll[0], ll[1], wards as Parameters<typeof getWardNameForLngLat>[2]);
}

export function featureMatchesAssignedWardsResolved(
  f: GeoFeature,
  assigned: string[],
  wards: { features?: unknown[] } | null | undefined
): boolean {
  if (assigned.length === 0) return true;
  const label = effectiveWardLabelForFeature(f, wards);
  if (!label) return false;
  return wardMatchesAssignedList(label, assigned);
}

export function staticLandmarkMatchesAssignedWards(
  lng: number,
  lat: number,
  properties: Record<string, any>,
  assigned: string[] | undefined,
  wards: { features?: unknown[] } | null | undefined
): boolean {
  if (assigned === undefined) return true; // No role-based filter (e.g., admin)
  if (assigned.length === 0) return false; // Assigned filtering active but empty => no scope
  const fromProps = wardLabelFromAttributes(properties);
  const label = fromProps || (wards ? getWardNameForLngLat(lng, lat, wards as any) : null);
  if (!label) return false;
  return wardMatchesAssignedList(label, assigned);
}
