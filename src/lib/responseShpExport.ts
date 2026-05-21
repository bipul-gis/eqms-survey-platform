/**
 * Shapefile (ZIP) export for questionnaire responses — point layer with the
 * same attribute columns as the CSV export.
 */

import JSZip from 'jszip';
import { Questionnaire, QuestionnaireResponse } from '../types';
import { patchShapefileZipUtf8Dbf } from './dbfUtf8';
import {
  buildResponsesShpFieldMappingCsv,
  buildResponsesTable,
  responsePointForShp,
  slugifyExportBasename
} from './responseExport';

const loadShpWrite = () => import('@mapbox/shp-write').then((m) => m.default ?? m);

const WGS84_PRJ =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",' +
  'SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
  'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

const toShpPrimitive = (v: unknown): string | number | boolean => {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v === null || v === undefined) return '';
  return String(v);
};

export type ResponsesShpExportResult = {
  exported: number;
  skippedNoGps: number;
};

export async function downloadResponsesShpZip(
  q: Questionnaire,
  responses: QuestionnaireResponse[]
): Promise<ResponsesShpExportResult> {
  const { header, rows } = buildResponsesTable(q, responses);
  const features: Array<{
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: Record<string, string | number | boolean>;
  }> = [];

  let skippedNoGps = 0;
  for (let i = 0; i < responses.length; i++) {
    const coords = responsePointForShp(responses[i]);
    if (!coords) {
      skippedNoGps += 1;
      continue;
    }
    const properties: Record<string, string | number | boolean> = {};
    for (let j = 0; j < header.length; j++) {
      properties[header[j]] = toShpPrimitive(rows[i][j]);
    }
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: coords },
      properties
    });
  }

  if (features.length === 0) {
    throw new Error(
      skippedNoGps > 0
        ? 'No responses with valid latitude/longitude to export as points.'
        : 'Nothing to export.'
    );
  }

  const baseName = `${slugifyExportBasename(q.title)}_responses`;
  const exportPayload = {
    type: 'FeatureCollection' as const,
    name: baseName,
    features
  };

  const shpwrite = await loadShpWrite();
  const zipResult = await shpwrite.zip(exportPayload as any, {
    folder: baseName,
    types: { point: baseName },
    prj: WGS84_PRJ,
    outputType: 'blob',
    compression: 'STORE'
  });

  let blob =
    zipResult instanceof Blob
      ? zipResult
      : new Blob([zipResult as BlobPart], { type: 'application/zip' });

  const propRows = features.map((f) => f.properties as Record<string, unknown>);
  blob = await patchShapefileZipUtf8Dbf(blob, baseName, baseName, propRows);

  const mappingCsv = buildResponsesShpFieldMappingCsv(q, responses);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  zip.file(`${baseName}_field_mapping.csv`, mappingCsv);
  blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${baseName}_${Date.now()}.zip`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);

  return { exported: features.length, skippedNoGps };
}
