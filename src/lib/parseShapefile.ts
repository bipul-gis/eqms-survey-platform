/**
 * Parse a zipped shapefile (.zip containing .shp/.dbf/.prj) or raw .shp pair
 * into GeoJSON polygon features for zone-layer import.
 */
import shp from 'shpjs';

export interface ParsedZoneFeature {
  properties: Record<string, unknown>;
  geometry: Record<string, unknown>;
}

export interface ParsedZoneLayer {
  name: string;
  features: ParsedZoneFeature[];
  attributeFields: string[];
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

/** Suggest a map label field: prefer human-readable name attributes. */
export function suggestLabelField(fields: string[]): string | null {
  if (fields.length === 0) return null;
  const preferred = [
    'NAME',
    'Name',
    'name',
    'LABEL',
    'Label',
    'ZONE_NAME',
    'Zone_Name',
    'ZoneName',
    'SUB_ZONE',
    'Sub_Zone',
    'Ward_Name',
    'WARDNAME',
    'WardName',
    'WARD_NAME',
    'TITLE',
    'Title',
  ];
  for (const p of preferred) {
    const hit = fields.find((f) => f === p || f.toLowerCase() === p.toLowerCase());
    if (hit) return hit;
  }
  return suggestAssignmentField(fields);
}

export async function parseZoneShapefileZip(file: File | ArrayBuffer): Promise<{
  layers: ParsedZoneLayer[];
  features: ParsedZoneFeature[];
  attributeFields: string[];
}> {
  const buffer = file instanceof File ? await file.arrayBuffer() : file;
  const geo = await shp(buffer);
  const fallbackName = file instanceof File ? file.name.replace(/\.zip$/i, '') || 'Zones' : 'Zones';
  const getLayerName = (rawName: unknown, fallback: string) => {
    const path = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : fallback;
    return path.replace(/\\/g, '/').split('/').pop()?.replace(/\.(shp|geojson|json)$/i, '').trim() || fallback;
  };
  const grouped: Array<{ name: string; features: ParsedZoneFeature[] }> = [];
  const collectGroups = (value: unknown, name: string) => {
    if (!value || typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    if (obj.type === 'FeatureCollection' || obj.type === 'Feature') {
      const features = collectFeatures(value);
      if (features.length) grouped.push({ name: getLayerName(obj.fileName, name), features });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const itemName = item && typeof item === 'object' ? (item as Record<string, unknown>).fileName : null;
        collectGroups(item, getLayerName(itemName, `${name} ${index + 1}`));
      });
      return;
    }
    for (const [key, child] of Object.entries(obj)) {
      collectGroups(child, key || name);
    }
  };
  collectGroups(geo, fallbackName);
  const layers = grouped.map((group) => ({
    ...group,
    name: getLayerName(group.name, fallbackName),
    attributeFields: attributeFieldsFromFeatures(group.features),
  }));
  // A shapefile ZIP with one layer may be returned in an unexpected wrapper shape.
  const features = layers.length ? layers.flatMap((layer) => layer.features) : collectFeatures(geo);
  if (features.length === 0) {
    throw new Error('No polygon/multipolygon features found in the shapefile.');
  }
  const attributeFields = attributeFieldsFromFeatures(features);
  return { layers: layers.length ? layers : [{ name: fallbackName, features, attributeFields }], features, attributeFields };
}
