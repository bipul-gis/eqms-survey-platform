import type { GeoFeature, FeatureStatus, ZonePolygon } from '../types';
import { patchShapefileZipUtf8Dbf } from './dbfUtf8';

// Lazy-load @mapbox/shp-write on demand
const loadShpWrite = () => import('@mapbox/shp-write').then((m) => m.default ?? m);

export type StatusFilterOption = 'all' | FeatureStatus;

const WGS84_PRJ =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",' +
  'SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
  'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

function csvEscape(value: unknown): string {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').toLowerCase() || 'geospatial_export';
}

function resolveFeatureStatus(f: GeoFeature): FeatureStatus {
  const attrs = (f.attributes || {}) as Record<string, unknown>;
  const raw = attrs.QC_Status ?? attrs.qc_status ?? attrs.Status ?? attrs.status ?? f.status;
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'verified' || s === 'rejected' || s === 'pending') {
    return s as FeatureStatus;
  }
  return f.status || 'pending';
}

export function filterFeaturesByStatus(features: GeoFeature[], statusFilter: StatusFilterOption): GeoFeature[] {
  if (statusFilter === 'all') return features;
  return features.filter((f) => resolveFeatureStatus(f) === statusFilter);
}

export function filterZonePolygonsByStatus(polygons: ZonePolygon[], statusFilter: StatusFilterOption): ZonePolygon[] {
  if (statusFilter === 'all') return polygons;
  return polygons.filter((p) => {
    const props = p.properties || {};
    const raw = props.QC_Status ?? props.qc_status ?? props.Status ?? props.status;
    const s = String(raw || '').trim().toLowerCase();
    const resolved = s === 'verified' || s === 'rejected' || s === 'pending' ? s : 'pending';
    return resolved === statusFilter;
  });
}

/**
 * Clean properties for export: strip private __ keys and include resolved Status / coordinates
 */
function cleanPropertiesForExport(raw: Record<string, unknown>, extraStatus?: string, coords?: [number, number]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('__')) continue;
    out[k] = v == null ? '' : v;
  }
  if (extraStatus) {
    out.Status = extraStatus;
  }
  if (coords) {
    if (out.Longitude == null && out.lng == null && out.GPS_Lng == null) out.Longitude = coords[0];
    if (out.Latitude == null && out.lat == null && out.GPS_Lat == null) out.Latitude = coords[1];
  }
  return out;
}

/**
 * Export features / rows to CSV string
 */
export function exportFeaturesToCsv(
  items: Array<{ id: string; properties: Record<string, unknown>; coordinates?: [number, number]; status?: string }>,
  columns: string[]
): string {
  const allColsSet = new Set<string>();
  columns.forEach((c) => {
    if (!c.startsWith('__')) allColsSet.add(c);
  });
  // Ensure Status and GPS coordinate columns are present if available
  allColsSet.add('Status');
  allColsSet.add('Longitude');
  allColsSet.add('Latitude');

  items.forEach((item) => {
    Object.keys(item.properties).forEach((k) => {
      if (!k.startsWith('__')) allColsSet.add(k);
    });
  });

  const headerList = Array.from(allColsSet);
  const rows: string[] = [headerList.map(csvEscape).join(',')];

  for (const item of items) {
    const cleaned = cleanPropertiesForExport(item.properties, item.status, item.coordinates);
    const rowValues = headerList.map((header) => csvEscape(cleaned[header]));
    rows.push(rowValues.join(','));
  }

  return rows.join('\r\n');
}

/**
 * Trigger browser file download for a Blob
 */
export function triggerFileDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/**
 * Download layer features as CSV
 */
export function downloadLayerAsCsv(
  layerName: string,
  items: Array<{ id: string; properties: Record<string, unknown>; coordinates?: [number, number]; status?: string }>,
  columns: string[],
  statusFilter: StatusFilterOption
): void {
  const csvContent = exportFeaturesToCsv(items, columns);
  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const timeStr = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = sanitizeFileName(layerName);
  const statusStr = statusFilter !== 'all' ? `_${statusFilter}` : '';
  triggerFileDownload(blob, `${safeName}${statusStr}_${timeStr}.csv`);
}

/**
 * Download layer features as Shapefile ZIP
 */
export async function downloadLayerAsShpZip(
  layerName: string,
  features: GeoFeature[],
  statusFilter: StatusFilterOption
): Promise<{ count: number }> {
  const filtered = filterFeaturesByStatus(features, statusFilter);
  if (filtered.length === 0) {
    throw new Error('No features match the selected status filter to export.');
  }

  const safeName = sanitizeFileName(layerName).slice(0, 10); // ArcMap best practice: max 10 chars base name

  // Filter out any features with invalid or missing geometries
  const validFeatures = filtered.filter((f) => {
    if (!f.geometry || !f.geometry.coordinates) return false;
    if (f.geometry.type === 'Point') {
      const c = f.geometry.coordinates;
      return Array.isArray(c) && c.length >= 2 && Number.isFinite(Number(c[0])) && Number.isFinite(Number(c[1]));
    }
    return true;
  });

  if (validFeatures.length === 0) {
    throw new Error('No valid geometric features found to export.');
  }

  const geoJsonFeatures = validFeatures.map((f) => {
    const coords = f.geometry?.coordinates;
    const resolvedStatus = resolveFeatureStatus(f);
    let geom = f.geometry;
    let pointCoord: [number, number] | undefined;

    if (f.geometry?.type === 'Point' && Array.isArray(coords)) {
      const lng = Number(coords[0]);
      const lat = Number(coords[1]);
      geom = { type: 'Point', coordinates: [lng, lat] };
      pointCoord = [lng, lat];
    }

    const props = cleanPropertiesForExport(f.attributes || {}, resolvedStatus, pointCoord);
    return {
      type: 'Feature' as const,
      id: f.id,
      geometry: geom,
      properties: props,
    };
  });

  const exportPayload = {
    type: 'FeatureCollection',
    name: safeName,
    features: geoJsonFeatures,
  };

  const shpwrite = await loadShpWrite();
  const zipResult = await shpwrite.zip(exportPayload as any, {
    types: {
      point: safeName,
      polygon: safeName,
      line: safeName,
    },
    prj: WGS84_PRJ,
    outputType: 'blob',
    compression: 'STORE',
  });

  let blob = zipResult instanceof Blob
    ? zipResult
    : new Blob([zipResult as BlobPart], { type: 'application/zip' });

  const propRows = geoJsonFeatures.map((f) => f.properties);
  blob = await patchShapefileZipUtf8Dbf(blob, '', safeName, propRows);

  const timeStr = new Date().toISOString().replace(/[:.]/g, '-');
  const statusStr = statusFilter !== 'all' ? `_${statusFilter}` : '';
  triggerFileDownload(blob, `${safeName}${statusStr}_${timeStr}.zip`);

  return { count: validFeatures.length };
}

/**
 * Download zone polygons as Shapefile ZIP
 */
export async function downloadZonePolygonsAsShpZip(
  layerName: string,
  polygons: ZonePolygon[],
  statusFilter: StatusFilterOption
): Promise<{ count: number }> {
  const filtered = filterZonePolygonsByStatus(polygons, statusFilter);
  if (filtered.length === 0) {
    throw new Error('No zone polygons match the selected status filter to export.');
  }

  const safeName = sanitizeFileName(layerName).slice(0, 10);

  const validPolygons = filtered.filter((p) => {
    const g = p.geometry as any;
    return g && g.coordinates && Array.isArray(g.coordinates);
  });

  if (validPolygons.length === 0) {
    throw new Error('No valid polygon geometries to export.');
  }

  const geoJsonFeatures = validPolygons.map((p) => {
    const props = p.properties || {};
    const raw = props.QC_Status ?? props.qc_status ?? props.Status ?? props.status;
    const s = String(raw || '').trim().toLowerCase();
    const resolvedStatus = s === 'verified' || s === 'rejected' || s === 'pending' ? s : 'pending';

    return {
      type: 'Feature' as const,
      id: p.id,
      geometry: p.geometry,
      properties: cleanPropertiesForExport(props, resolvedStatus),
    };
  });

  const exportPayload = {
    type: 'FeatureCollection',
    name: safeName,
    features: geoJsonFeatures,
  };

  const shpwrite = await loadShpWrite();
  const zipResult = await shpwrite.zip(exportPayload as any, {
    types: {
      polygon: safeName,
    },
    prj: WGS84_PRJ,
    outputType: 'blob',
    compression: 'STORE',
  });

  let blob = zipResult instanceof Blob
    ? zipResult
    : new Blob([zipResult as BlobPart], { type: 'application/zip' });

  const propRows = geoJsonFeatures.map((f) => f.properties);
  blob = await patchShapefileZipUtf8Dbf(blob, '', safeName, propRows);

  const timeStr = new Date().toISOString().replace(/[:.]/g, '-');
  const statusStr = statusFilter !== 'all' ? `_${statusFilter}` : '';
  triggerFileDownload(blob, `${safeName}${statusStr}_${timeStr}.zip`);

    return { count: validPolygons.length };
}
