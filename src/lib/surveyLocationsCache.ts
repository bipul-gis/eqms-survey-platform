export type CachedSurveyLocation = {
  id: string;
  lat: number;
  lng: number;
  accuracy?: number;
  respondentName?: string;
  respondentEmail?: string;
  questionnaireId: string;
  status: 'draft' | 'submitted' | 'reviewed';
  submittedAt?: unknown;
  capturedAt?: unknown;
  ward?: string;
};

type SurveyLocationsBundle = {
  locations: CachedSurveyLocation[];
  savedAt: number;
};

const memory = new Map<string, SurveyLocationsBundle>();
const STORAGE_PREFIX = 'eqms.surveyLocs:';
const MAX_AGE_MS = 30 * 60 * 1000;

function storageKey(cacheKey: string) {
  return `${STORAGE_PREFIX}${cacheKey}`;
}

export function surveyLocationsCacheKey(
  projectId: string | undefined,
  mode: string,
  userUid?: string
) {
  return `${projectId || 'all'}:${mode}:${userUid || ''}`;
}

export function readCachedSurveyLocations(cacheKey: string): CachedSurveyLocation[] | null {
  const mem = memory.get(cacheKey);
  if (mem && Date.now() - mem.savedAt < MAX_AGE_MS) return mem.locations;
  try {
    const raw = sessionStorage.getItem(storageKey(cacheKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SurveyLocationsBundle;
    if (!parsed || typeof parsed.savedAt !== 'number' || !Array.isArray(parsed.locations)) {
      return null;
    }
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) return null;
    memory.set(cacheKey, parsed);
    return parsed.locations;
  } catch {
    return null;
  }
}

export function writeCachedSurveyLocations(
  cacheKey: string,
  locations: CachedSurveyLocation[]
): void {
  const bundle: SurveyLocationsBundle = { locations, savedAt: Date.now() };
  memory.set(cacheKey, bundle);
  try {
    sessionStorage.setItem(storageKey(cacheKey), JSON.stringify(bundle));
  } catch {
    /* quota / private mode */
  }
}

export function clearCachedSurveyLocations(cacheKey?: string): void {
  if (cacheKey) {
    memory.delete(cacheKey);
    try {
      sessionStorage.removeItem(storageKey(cacheKey));
    } catch {
      /* ignore */
    }
    return;
  }
  memory.clear();
}
