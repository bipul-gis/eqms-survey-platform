import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from './firebase';
import { getCached, invalidateCached, setCached } from './firestoreReadCache';
import {
  formatDwellingId,
  nextDwellingSequenceFromValues,
  parseDwellingSequence
} from './slumRegistry';

const DWELLING_CACHE_TTL_MS = 15_000;

/** Call after saving a response so the next form open sees the latest sequence. */
export function invalidateDwellingIdCache(questionnaireId: string): void {
  invalidateCached(`dwelling:${questionnaireId}`);
}

export function collectDwellingValuesFromPools(
  pools: Array<Record<string, unknown> | undefined>,
  slumId: string
): unknown[] {
  const values: unknown[] = [];
  for (const pool of pools) {
    if (!pool || typeof pool !== 'object') continue;
    for (const v of Object.values(pool)) {
      if (parseDwellingSequence(v, slumId) !== null) values.push(v);
    }
  }
  return values;
}

export type LoadDwellingIdOptions = {
  /** When set, only this enumerator's responses are counted (recommended in the field app). */
  respondentId?: string;
  /** Ignore this response doc when computing the next number (current draft/submit). */
  excludeResponseId?: string;
};

/**
 * Collect dwelling-id values already stored for a questionnaire + slum.
 * When `respondentId` is provided, sequences are per enumerator (`{SLUMID}_1`, `_2`, …).
 * Without it, all enumerators share one sequence (admin-style scan).
 */
export async function loadDwellingIdValuesForQuestionnaire(
  questionnaireId: string,
  slumId: string,
  options?: LoadDwellingIdOptions
): Promise<unknown[]> {
  const respondentId = options?.respondentId?.trim() || '';
  const excludeResponseId = options?.excludeResponseId?.trim() || '';
  const cacheKey = `dwelling:${questionnaireId}:${slumId}:${respondentId || 'all'}:${excludeResponseId}`;
  const cached = getCached<unknown[]>(cacheKey, DWELLING_CACHE_TTL_MS);
  if (cached) return cached;

  const q = respondentId
    ? query(collection(db, 'questionnaireResponses'), where('respondentId', '==', respondentId))
    : query(
        collection(db, 'questionnaireResponses'),
        where('questionnaireId', '==', questionnaireId)
      );

  const snap = await getDocs(q);
  const values: unknown[] = [];
  snap.forEach((docSnap) => {
    if (excludeResponseId && docSnap.id === excludeResponseId) return;
    const data = docSnap.data() as {
      questionnaireId?: string;
      responses?: Record<string, unknown>;
      enumeratorInfo?: Record<string, unknown>;
    };
    if (respondentId && data.questionnaireId !== questionnaireId) return;
    values.push(
      ...collectDwellingValuesFromPools([data.responses, data.enumeratorInfo], slumId)
    );
  });
  setCached(cacheKey, values);
  return values;
}

/** Next dwelling id for this enumerator + questionnaire + slum. */
export async function allocateNextDwellingId(
  questionnaireId: string,
  slumId: string,
  respondentId: string,
  excludeResponseId?: string
): Promise<string> {
  const values = await loadDwellingIdValuesForQuestionnaire(questionnaireId, slumId, {
    respondentId,
    excludeResponseId
  });
  const seq = nextDwellingSequenceFromValues(values, slumId);
  return formatDwellingId(slumId, seq);
}

export function dwellingFieldsAreEmpty(
  enumFieldIds: string[],
  questionFieldIds: string[],
  enumeratorInfo: Record<string, unknown> | undefined,
  responses: Record<string, unknown> | undefined
): boolean {
  for (const id of enumFieldIds) {
    const v = enumeratorInfo?.[id];
    if (v !== undefined && v !== null && String(v).trim() !== '') return false;
  }
  for (const id of questionFieldIds) {
    const v = responses?.[id];
    if (v !== undefined && v !== null && String(v).trim() !== '') return false;
  }
  return true;
}

export function mergeDwellingIntoAnswerMaps(
  dwellingValue: string,
  enumFieldIds: string[],
  questionFieldIds: string[],
  enumeratorInfo: Record<string, unknown>,
  responses: Record<string, unknown>
): { enumeratorInfo: Record<string, unknown>; responses: Record<string, unknown> } {
  const nextEnumeratorInfo = { ...enumeratorInfo };
  const nextResponses = { ...responses };
  for (const id of enumFieldIds) nextEnumeratorInfo[id] = dwellingValue;
  for (const id of questionFieldIds) nextResponses[id] = dwellingValue;
  return { enumeratorInfo: nextEnumeratorInfo, responses: nextResponses };
}
