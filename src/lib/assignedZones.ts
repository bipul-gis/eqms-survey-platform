import type { UserProfile, ZonePolygon } from '../types';

export function assignedZoneValuesFromProfile(
  data: Pick<UserProfile, 'assignedZoneValues' | 'projectZoneAssignments'>,
  projectId?: string | null
): string[] {
  if (projectId && data.projectZoneAssignments?.[projectId]?.length) {
    return [
      ...new Set(data.projectZoneAssignments[projectId].map((v) => String(v).trim()).filter(Boolean)),
    ].sort((a, b) => a.localeCompare(b));
  }
  const list = data.assignedZoneValues;
  if (Array.isArray(list) && list.length > 0) {
    return [...new Set(list.map((v) => String(v).trim()).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b)
    );
  }
  return [];
}

export function filterZonesForEnumerator(
  polygons: ZonePolygon[],
  assignedValues: string[]
): ZonePolygon[] {
  if (!assignedValues.length) return [];
  const set = new Set(assignedValues.map((v) => v.trim().toLowerCase()));
  return polygons.filter((p) => {
    const v = (p.assignValue || '').trim().toLowerCase();
    return v && set.has(v);
  });
}

export function zonesToGeoJson(
  polygons: ZonePolygon[],
  opts?: { labelField?: string | null }
): GeoJSON.FeatureCollection {
  const labelField = opts?.labelField?.trim() || '';
  return {
    type: 'FeatureCollection',
    features: polygons.map((p) => {
      const fromLabelField =
        labelField && p.properties && p.properties[labelField] != null
          ? String(p.properties[labelField]).trim()
          : '';
      const label = fromLabelField || (p.assignValue ? String(p.assignValue).trim() : '') || '';
      return {
        type: 'Feature' as const,
        id: p.id,
        properties: {
          ...p.properties,
          __assignValue: p.assignValue,
          __label: label || null,
          __labelField: labelField || null,
          __zoneId: p.id,
        },
        geometry: p.geometry as GeoJSON.Geometry,
      };
    }),
  };
}
