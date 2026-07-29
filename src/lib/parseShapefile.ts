/**
 * Parse a zipped shapefile (.zip containing .shp/.dbf/.prj) or raw .shp pair
 * into GeoJSON polygon features for zone-layer import.
 */
import shp from 'shpjs';

export interface ParsedZoneFeature {
  properties: Record<string, unknown>;
  geometry: Record<string, unknown>;
}

function isPolygonGeom(g: unknown): g is { type: string; coordinates: unknown } {
  if (!g || typeof g !== 'object') return false;
  const t = (g as { type?: string }).type;
  return t === 'Polygon' || t === 'MultiPolygon';
}

function collectFeatures(geo: unknown): ParsedZoneFeature[] {
  const out: ParsedZoneFeature[] = [];
  const pushFeature = (f: { geometry?: unknown; properties?: Record<string, unknown> }) => {
    if (!isPolygonGeom(f.geometry)) return;
    out.push({
      properties: { ...(f.properties || {}) },
      geometry: f.geometry as Record<string, unknown>,
    });
  };

  if (!geo) return out;

  // shpjs may return FeatureCollection, array of FCs, or a map of layerName → FC
  if (Array.isArray(geo)) {
    for (const item of geo) collectFeatures(item).forEach((f) => out.push(f));
    return out;
  }

  if (typeof geo === 'object') {
    const obj = geo as Record<string, unknown>;
    if (obj.type === 'FeatureCollection' && Array.isArray(obj.features)) {
      for (const f of obj.features as Array<{ geometry?: unknown; properties?: Record<string, unknown> }>) {
        pushFeature(f);
      }
      return out;
    }
    if (obj.type === 'Feature') {
      pushFeature(obj as { geometry?: unknown; properties?: Record<string, unknown> });
      return out;
    }
    // Named layers object
    for (const v of Object.values(obj)) {
      collectFeatures(v).forEach((f) => out.push(f));
    }
  }
  return out;
}

export function attributeFieldsFromFeatures(features: ParsedZoneFeature[]): string[] {
  const keys = new Set<string>();
  for (const f of features) {
    for (const k of Object.keys(f.properties || {})) {
      if (k && !k.startsWith('__')) keys.add(k);
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

/** Suggest an assignment field: prefer common zone/ward id names. */
export function suggestAssignmentField(fields: string[]): string | null {
  if (fields.length === 0) return null;
  const preferred = [
    'ZONE_ID',
    'Zone_ID',
    'zone_id',
    'ZONEID',
    'ZoneID',
    'ZONE_NAME',
    'Zone_Name',
    'ZONE',
    'Ward_Name',
    'WARDNAME',
    'WardName',
    'WARD_NAME',
    'NAME',
    'Name',
    'ID',
    'Id',
  ];
  for (const p of preferred) {
    const hit = fields.find((f) => f === p || f.toLowerCase() === p.toLowerCase());
    if (hit) return hit;
  }
  return fields[0];
}

export async function parseZoneShapefileZip(file: File | ArrayBuffer): Promise<{
  features: ParsedZoneFeature[];
  attributeFields: string[];
}> {
  const buffer = file instanceof File ? await file.arrayBuffer() : file;
  const geo = await shp(buffer);
  const features = collectFeatures(geo);
  if (features.length === 0) {
    throw new Error('No polygon/multipolygon features found in the shapefile.');
  }
  const attributeFields = attributeFieldsFromFeatures(features);
  return { features, attributeFields };
}
