import type { FeatureType } from '../types';

/** Slum-related demographic / id fields (landmark GeoJSON / slum polygons). */
export const SLUM_DEMOGRAPHIC_KEYS = ['Female_Num', 'Household_', 'Pop_Num', 'Slum_ID'] as const;

export const SLUM_DEMOGRAPHIC_KEY_SET = new Set<string>([...SLUM_DEMOGRAPHIC_KEYS]);

/**
 * Show slum demographic fields when the feature is a slum boundary polygon or
 * Category/Type text indicates slum (case-insensitive).
 */
/** Category alone is treated as Slum (e.g. landmark GeoJSON `Category: Slum`). */
export function isSlumCategory(attrs: Record<string, any> | undefined): boolean {
  const cat = String(attrs?.Category ?? '').trim().toLowerCase();
  return cat.includes('slum');
}

export function shouldShowSlumNumericFields(
  attrs: Record<string, any> | undefined,
  featureType: FeatureType
): boolean {
  if (featureType === 'polygon') return true;
  const cat = String(attrs?.Category ?? '').trim().toLowerCase();
  const typ = String(attrs?.Type ?? '').trim().toLowerCase();
  return cat.includes('slum') || typ.includes('slum');
}
