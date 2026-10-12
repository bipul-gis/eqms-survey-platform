/**
 * Loads standalone HH survey GPS points and linked-feature completion status.
 *
 * Uses the slim `/api/responses/locations` endpoint (no answer payloads) and
 * paints standalone points instantly from session cache when available, then refreshes.
 */

import { useEffect, useState } from 'react';
import { geosurveyApi } from '../lib/geosurveyApi';
import {
  readCachedSurveyLocations,
  surveyLocationsCacheKey,
  writeCachedSurveyLocations,
} from '../lib/surveyLocationsCache';

export type SurveyLocationLoadMode = 'idle' | 'admin' | 'enumerator';

export interface SurveyLocationPoint {
  /** Response document id. Used as a stable React key + popup ref. */
  id: string;
  lat: number;
  lng: number;
  /** Meters — only present when sourced from `submissionLocation`. */
  accuracy?: number;
  /** Surveyor display name, when stored on the response. */
  respondentName?: string;
  respondentEmail?: string;
  questionnaireId: string;
  status: 'draft' | 'submitted' | 'reviewed';
  /** Timestamp (ISO string or legacy object). */
  submittedAt?: unknown;
  capturedAt?: unknown;
  ward?: string;
}

function normalizeStatus(raw: unknown): 'draft' | 'submitted' | 'reviewed' {
  if (raw === 'submitted' || raw === 'reviewed' || raw === 'draft') return raw;
  return 'draft';
}

function toPoint(item: {
  id: string;
  questionnaireId: string;
  status: string;
  respondentName?: string;
  respondentEmail?: string;
  submittedAt?: unknown;
  lat?: number;
  lng?: number;
  accuracy?: number;
  capturedAt?: unknown;
  ward?: string;
}): SurveyLocationPoint | null {
  const lat = typeof item.lat === 'number' ? item.lat : Number(item.lat);
  const lng = typeof item.lng === 'number' ? item.lng : Number(item.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    id: String(item.id ?? ''),
    lat,
    lng,
    accuracy: typeof item.accuracy === 'number' ? item.accuracy : undefined,
    capturedAt: item.capturedAt,
    respondentName: typeof item.respondentName === 'string' ? item.respondentName : undefined,
    respondentEmail: typeof item.respondentEmail === 'string' ? item.respondentEmail : undefined,
    questionnaireId: typeof item.questionnaireId === 'string' ? item.questionnaireId : '',
    status: normalizeStatus(item.status),
    submittedAt: item.submittedAt,
    ward: typeof item.ward === 'string' ? item.ward : undefined,
  };
}

export function useQuestionnaireSurveyLocations(options: {
  mode: SurveyLocationLoadMode;
  userUid: string | undefined;
  /** When false, neither pins nor linked-feature status is loaded. Default true. */
  enabled?: boolean;
  /** Restrict pins to this project's questionnaires. */
  projectId?: string;
}): { locations: SurveyLocationPoint[]; submittedFeatureIds: string[]; loading: boolean; error: Error | null } {
  const enabled = options.enabled !== false;
  const cacheKey = surveyLocationsCacheKey(
    options.projectId,
    options.mode,
    options.mode === 'enumerator' ? options.userUid : undefined
  );
  const [locations, setLocations] = useState<SurveyLocationPoint[]>(() => {
    if (!enabled || options.mode === 'idle') return [];
    return readCachedSurveyLocations(cacheKey) || [];
  });
  const [submittedFeatureIds, setSubmittedFeatureIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!enabled || options.mode === 'idle') {
      setLocations([]);
      setSubmittedFeatureIds([]);
      setLoading(false);
      setError(null);
      return;
    }
    if (options.mode === 'enumerator' && !options.userUid) {
      setLocations([]);
      setSubmittedFeatureIds([]);
      setLoading(false);
      return;
    }

    const cached = readCachedSurveyLocations(cacheKey);
    if (cached && cached.length > 0) {
      setLocations(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }
    setError(null);

    let cancelled = false;
    void (async () => {
      try {
        const result = await geosurveyApi.listResponseLocations({
          projectId: options.projectId,
          respondentId: options.mode === 'enumerator' ? options.userUid : undefined,
        });
        if (cancelled) return;
        const next: SurveyLocationPoint[] = [];
        const linkedSubmittedIds = new Set<string>();
        for (const item of result.items || []) {
          if (item.linkedFeatureId && ['submitted', 'reviewed'].includes(normalizeStatus(item.status))) {
            linkedSubmittedIds.add(String(item.linkedFeatureId));
          }
          // Linked responses should color their feature on the map, but must
          // never appear as a separate HH Survey Location marker.
          if (item.linkedFeatureId) continue;
          const point = toPoint(item);
          if (point) next.push(point);
        }
        setLocations(next);
        setSubmittedFeatureIds([...linkedSubmittedIds]);
        writeCachedSurveyLocations(cacheKey, next);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        // Keep cached paint on refresh failure.
        if (!cached || cached.length === 0) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, options.mode, options.userUid, options.projectId, cacheKey]);

  return { locations, submittedFeatureIds, loading, error };
}
