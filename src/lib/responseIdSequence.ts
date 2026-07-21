import { getCached, invalidateCached, setCached } from './firestoreReadCache';
import { geosurveyApi } from './geosurveyApi';
import type { Question, QuestionnaireResponse } from '../types';

const CACHE_TTL_MS = 15_000;

export function invalidateResponseIdCache(questionnaireId: string): void {
  invalidateCached(`responseId:${questionnaireId}`);
}

/** Parse a plain positive integer serial (e.g. `"12"` → `12`). */
export function parseResponseIdSerial(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function formatResponseIdSerial(serial: number): string {
  return String(serial);
}

export function isPlainResponseIdValue(value: unknown): boolean {
  return parseResponseIdSerial(value) !== null;
}

function collectSerialsFromFieldIds(
  pools: Array<Record<string, unknown> | undefined>,
  fieldIds: string[]
): number[] {
  const out: number[] = [];
  const idSet = new Set(fieldIds);
  if (idSet.size === 0) return out;
  for (const pool of pools) {
    if (!pool) continue;
    for (const id of idSet) {
      const seq = parseResponseIdSerial(pool[id]);
      if (seq != null) out.push(seq);
    }
  }
  return out;
}

/**
 * Next plain serial for this enumerator × questionnaire.
 * Values are `1`, `2`, `3`… (number format, no prefix).
 */
export async function allocateNextResponseId(options: {
  questionnaireId: string;
  respondentId: string;
  responseIdFieldIds: string[];
  excludeResponseId?: string;
}): Promise<string> {
  const { questionnaireId, respondentId, responseIdFieldIds, excludeResponseId } = options;

  const cacheKey = `responseId:${questionnaireId}:${respondentId}:${excludeResponseId || ''}`;
  const cachedNext = getCached<number>(cacheKey, CACHE_TTL_MS);

  let nextSerial: number;
  if (typeof cachedNext === 'number' && cachedNext > 0) {
    nextSerial = cachedNext;
  } else {
    const result = await geosurveyApi.listResponses({ respondentId });
    const serials: number[] = [];
    for (const item of result.items) {
      const data = item as {
        id?: string;
        questionnaireId?: string;
        responses?: Record<string, unknown>;
        enumeratorInfo?: Record<string, unknown>;
      };
      if (excludeResponseId && data.id === excludeResponseId) continue;
      if (data.questionnaireId !== questionnaireId) continue;
      serials.push(
        ...collectSerialsFromFieldIds(
          [data.responses, data.enumeratorInfo],
          responseIdFieldIds
        )
      );
    }
    nextSerial = serials.length > 0 ? Math.max(...serials) + 1 : 1;
  }

  // Optimistic bump so rapid consecutive opens don't reuse the same number
  // before the first save lands.
  setCached(cacheKey, nextSerial + 1);
  return formatResponseIdSerial(nextSerial);
}

/** Apply one allocated serial onto every responseId question field. */
export function mergeResponseIdIntoAnswers(
  value: string,
  fieldIds: string[],
  answers: Record<string, unknown>
): Record<string, unknown> {
  if (fieldIds.length === 0) return answers;
  let dirty = false;
  const next = { ...answers };
  for (const id of fieldIds) {
    if (next[id] !== value) {
      next[id] = value;
      dirty = true;
    }
  }
  return dirty ? next : answers;
}

/** Read the auto Response ID serial from a saved response (for list UIs). */
export function readResponseIdSerial(
  response: Pick<QuestionnaireResponse, 'responses'>,
  questions: Question[] | undefined
): string | null {
  const fieldIds = (questions || []).filter((q) => q.type === 'responseId').map((q) => q.id);
  if (fieldIds.length === 0) return null;
  const pool = response.responses || {};
  for (const id of fieldIds) {
    const serial = parseResponseIdSerial(pool[id]);
    if (serial != null) return formatResponseIdSerial(serial);
  }
  return null;
}
