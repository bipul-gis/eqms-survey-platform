import type { ZoneLayer, ZonePolygon } from '../types';

type ZoneBundle = {
  layer: ZoneLayer | null;
  polygons: ZonePolygon[];
  savedAt: number;
};

const memory = new Map<string, ZoneBundle>();
const STORAGE_PREFIX = 'eqms.zoneBundle:';
const MAX_AGE_MS = 30 * 60 * 1000;

function storageKey(projectId: string) {
  return `${STORAGE_PREFIX}${projectId}`;
}

export function readCachedZoneBundle(projectId: string): ZoneBundle | null {
  const mem = memory.get(projectId);
  if (mem && Date.now() - mem.savedAt < MAX_AGE_MS) return mem;
  try {
    const raw = sessionStorage.getItem(storageKey(projectId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ZoneBundle;
    if (!parsed || typeof parsed.savedAt !== 'number') return null;
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) return null;
    memory.set(projectId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function writeCachedZoneBundle(
  projectId: string,
  layer: ZoneLayer | null,
  polygons: ZonePolygon[]
): void {
  const bundle: ZoneBundle = { layer, polygons, savedAt: Date.now() };
  memory.set(projectId, bundle);
  try {
    sessionStorage.setItem(storageKey(projectId), JSON.stringify(bundle));
  } catch {
    /* quota / private mode */
  }
}

export function clearCachedZoneBundle(projectId?: string): void {
  if (projectId) {
    memory.delete(projectId);
    try {
      sessionStorage.removeItem(storageKey(projectId));
    } catch {
      /* ignore */
    }
    return;
  }
  memory.clear();
}
