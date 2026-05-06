import type { GeoFeature } from '../types';
import {
  isSlumCategory,
  shouldShowSlumNumericFields,
  SLUM_DEMOGRAPHIC_KEYS
} from './slumFeatureFields';

const READ_ONLY_ATTRS = new Set(['_source']);

/**
 * Required landmark-point fields — aligned with FeatureEditor validation (core + slum + ownership).
 */
export function isLandmarkPointFormComplete(feature: GeoFeature): boolean {
  if (feature.type !== 'point') return false;
  const a = feature.attributes || {};
  const category = String(a.Category ?? '').trim();
  const showOwnership = category === 'Health Facilities';
  const slum = shouldShowSlumNumericFields(a, feature.type);

  const entries: Array<[string, unknown]> = [
    ['name', a.name ?? a.Name ?? ''],
    ['Category', a.Category ?? ''],
    ['Type', a.Type ?? ''],
    ['Ward_Name', a.Ward_Name ?? a.WARDNAME ?? a.WardName ?? '']
  ];
  if (showOwnership) entries.push(['Ownership', a.Ownership ?? '']);
  if (slum) {
    for (const k of SLUM_DEMOGRAPHIC_KEYS) entries.push([k, a[k] ?? '']);
  }

  for (const [key, value] of entries) {
    if (READ_ONLY_ATTRS.has(key)) continue;
    if (key === 'Ownership' && !showOwnership) continue;
    if (key === 'Type' && isSlumCategory(a)) continue;
    if (!String(value ?? '').trim()) return false;
  }
  return true;
}

/**
 * True when the record reflects field / QC work beyond automated baseline import — scopes "Changed SHP".
 * (Does not use `updatedBy` alone: admin GeoJSON merges also set a non-import email.)
 */
export function landmarkHasEnumeratorActivity(feature: GeoFeature): boolean {
  if (feature.status !== 'pending') return true;
  const src = String(feature.attributes?.__source || '');
  if (src.includes('landmark_manual')) return true;
  if (String(feature.attributes?.ChangeBy ?? '').trim()) return true;
  if (String(feature.moveRemarks ?? '').trim()) return true;
  if (String(feature.newFeatureRemarks ?? '').trim()) return true;
  if (String(feature.remarks ?? '').trim()) return true;
  return false;
}
