import { geosurveyApi } from './geosurveyApi';
import type { GeoFeature } from '../types';

export async function fetchAllFeatures(): Promise<GeoFeature[]> {
  const { items } = await geosurveyApi.listFeatures();
  return items as unknown as GeoFeature[];
}

export async function createFeature(payload: Record<string, unknown>): Promise<GeoFeature> {
  return (await geosurveyApi.saveFeature(payload)) as unknown as GeoFeature;
}

export async function updateFeature(id: string, patch: Record<string, unknown>): Promise<GeoFeature> {
  return (await geosurveyApi.saveFeature({ ...patch, id })) as unknown as GeoFeature;
}

export async function deleteAllFeaturesPaginated(
  onProgress?: (deleted: number) => void
): Promise<number> {
  const { items } = await geosurveyApi.listFeatures();
  const ids = items.map((f) => String(f.id));
  const chunkSize = 200;
  let deleted = 0;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const res = await geosurveyApi.bulkDeleteFeatures(chunk);
    deleted += res.count;
    onProgress?.(deleted);
  }
  return deleted;
}

export async function bulkUpsertFeatures(items: Record<string, unknown>[]): Promise<number> {
  const chunkSize = 100;
  let count = 0;
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const res = await geosurveyApi.bulkSaveFeatures(chunk);
    count += res.count;
  }
  return count;
}

export async function bulkVerifyFeatures(
  ids: string[],
  verifiedBy: string
): Promise<void> {
  const { items } = await geosurveyApi.listFeatures();
  const now = new Date().toISOString();
  const toUpdate = items.filter((f) => ids.includes(String(f.id)));
  for (const item of toUpdate) {
    await geosurveyApi.saveFeature({
      ...item,
      status: 'verified',
      verifiedAt: now,
      verifiedBy,
    });
  }
}

export async function listApprovedUsers() {
  const { items } = await geosurveyApi.listUsers();
  return items.filter((u) => u.status === 'approved');
}
