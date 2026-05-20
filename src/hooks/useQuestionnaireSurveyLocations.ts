/**
 * useQuestionnaireSurveyLocations — loads HH-survey GPS points from the
 * `questionnaireResponses` Firestore collection and exposes them in a
 * normalized shape the map layer can render directly.
 *
 * Role-based scoping matches firestore.rules:
 *   - `admin`: subscribes to the whole collection (admins can read all
 *     responses).
 *   - `enumerator`: subscribes only to that enumerator's own responses
 *     (`respondentId == uid`), so the layer still works on the
 *     enumerator side without tripping security rules.
 *   - `idle`: no listener attached. Used while auth state is loading or
 *     for unauthenticated viewers.
 *
 * Each response can contribute one point. We prefer `submissionLocation`
 * (the deliberate end-of-survey capture with accuracy + timestamp). If
 * that's missing — e.g. older responses, or drafts saved before the GPS
 * step — we fall back to the looser `location` field. Responses with no
 * usable coordinates are filtered out.
 */

import { useEffect, useState } from 'react';
import {
  collection,
  onSnapshot,
  query,
  where,
  type Unsubscribe
} from 'firebase/firestore';
import { db } from '../lib/firebase';

export type SurveyLocationLoadMode = 'idle' | 'admin' | 'enumerator';

export interface SurveyLocationPoint {
  /** Firestore response document id. Used as a stable React key + popup ref. */
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
  /** Firestore Timestamp (or string in some legacy docs). */
  submittedAt?: unknown;
  capturedAt?: unknown;
  ward?: string;
}

function pickLatLng(data: Record<string, unknown>):
  | { lat: number; lng: number; accuracy?: number; capturedAt?: unknown }
  | null {
  // `submissionLocation` is the canonical end-of-survey capture — prefer
  // it because it includes accuracy and the deliberate "I'm done" timestamp.
  const sub = data.submissionLocation as
    | { lat?: unknown; lng?: unknown; accuracy?: unknown; capturedAt?: unknown }
    | undefined;
  if (
    sub &&
    typeof sub.lat === 'number' &&
    typeof sub.lng === 'number' &&
    Number.isFinite(sub.lat) &&
    Number.isFinite(sub.lng)
  ) {
    return {
      lat: sub.lat,
      lng: sub.lng,
      accuracy: typeof sub.accuracy === 'number' ? sub.accuracy : undefined,
      capturedAt: sub.capturedAt
    };
  }
  // Fallback: `location` is the older / lighter field, used by some auto-
  // fill paths and pre-submission-GPS responses.
  const loc = data.location as { lat?: unknown; lng?: unknown } | undefined;
  if (
    loc &&
    typeof loc.lat === 'number' &&
    typeof loc.lng === 'number' &&
    Number.isFinite(loc.lat) &&
    Number.isFinite(loc.lng)
  ) {
    return { lat: loc.lat, lng: loc.lng };
  }
  return null;
}

function normalizeStatus(raw: unknown): 'draft' | 'submitted' | 'reviewed' {
  if (raw === 'submitted' || raw === 'reviewed' || raw === 'draft') return raw;
  return 'draft';
}

export function useQuestionnaireSurveyLocations(options: {
  mode: SurveyLocationLoadMode;
  userUid: string | undefined;
  /** When false, no Firestore listener is attached (admin HH layer off). Default true. */
  enabled?: boolean;
}): { locations: SurveyLocationPoint[]; loading: boolean; error: Error | null } {
  const enabled = options.enabled !== false;
  const [locations, setLocations] = useState<SurveyLocationPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!enabled || options.mode === 'idle') {
      setLocations([]);
      setLoading(false);
      setError(null);
      return;
    }
    if (options.mode === 'enumerator' && !options.userUid) {
      setLocations([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const base = collection(db, 'questionnaireResponses');
    // Admin sees every response; enumerators are constrained by Firestore
    // rules to their own respondentId. Matching that constraint here also
    // saves bandwidth on the enumerator side.
    const q =
      options.mode === 'admin'
        ? base
        : query(base, where('respondentId', '==', options.userUid));

    const unsub: Unsubscribe = onSnapshot(
      q,
      (snap) => {
        const next: SurveyLocationPoint[] = [];
        snap.forEach((docSnap) => {
          const data = docSnap.data() as Record<string, unknown>;
          const coords = pickLatLng(data);
          if (!coords) return;
          next.push({
            id: docSnap.id,
            lat: coords.lat,
            lng: coords.lng,
            accuracy: coords.accuracy,
            capturedAt: coords.capturedAt,
            respondentName:
              typeof data.respondentName === 'string' ? data.respondentName : undefined,
            respondentEmail:
              typeof data.respondentEmail === 'string' ? data.respondentEmail : undefined,
            questionnaireId:
              typeof data.questionnaireId === 'string' ? data.questionnaireId : '',
            status: normalizeStatus(data.status),
            submittedAt: data.submittedAt,
            ward:
              data.location && typeof (data.location as any)?.ward === 'string'
                ? (data.location as any).ward
                : undefined
          });
        });
        setLocations(next);
        setLoading(false);
      },
      (err) => {
        // Silent in console-friendly state — the consumer can show a
        // toast if it wants, but a missing layer shouldn't break the
        // rest of the map UI.
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      }
    );

    return () => {
      unsub();
    };
  }, [enabled, options.mode, options.userUid]);

  return { locations, loading, error };
}
