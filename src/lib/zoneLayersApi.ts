import { getApiBase, getStoredSessionToken, ApiError } from './geosurveyApi';
import type { ZoneLayer, ZonePolygon } from '../types';

async function zoneFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getStoredSessionToken();
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(`${getApiBase()}${path}`, { ...init, headers });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) message = String(body.error);
    } catch {
      /* ignore */
    }
    throw new ApiError(message, res.status);
  }
  return res.json() as Promise<T>;
}

export const zoneLayersApi = {
  listLayers: (projectId?: string) =>
    zoneFetch<{ items: ZoneLayer[] }>(
      `/api/zone-layers${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`
    ),

  getLayer: (id: string) => zoneFetch<ZoneLayer>(`/api/zone-layers/${id}`),

  listAssignValues: (layerId: string) =>
    zoneFetch<{ values: string[] }>(`/api/zone-layers/${layerId}/assign-values`),

  listPolygons: (opts?: { layerId?: string; projectId?: string; assignValues?: string[] }) => {
    const q = new URLSearchParams();
    if (opts?.layerId) q.set('layerId', opts.layerId);
    if (opts?.projectId) q.set('projectId', opts.projectId);
    if (opts?.assignValues?.length) q.set('assignValues', opts.assignValues.join(','));
    const qs = q.toString();
    return zoneFetch<{ items: ZonePolygon[] }>(`/api/zone-polygons${qs ? `?${qs}` : ''}`);
  },

  importLayer: (body: {
    projectId: string;
    name?: string;
    assignmentField?: string | null;
    attributeFields: string[];
    strictGeofence?: boolean;
    polygons: Array<{
      assignValue?: string | null;
      properties: Record<string, unknown>;
      geometry: Record<string, unknown>;
    }>;
  }) =>
    zoneFetch<{ layer: ZoneLayer; polygons: ZonePolygon[] }>('/api/zone-layers/import', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateLayer: (
    id: string,
    patch: { name?: string; assignmentField?: string | null; strictGeofence?: boolean }
  ) =>
    zoneFetch<ZoneLayer>(`/api/zone-layers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteLayer: (id: string) =>
    zoneFetch<{ ok: boolean }>(`/api/zone-layers/${id}`, { method: 'DELETE' }),
};
