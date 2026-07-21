import { getCached, invalidateCached, setCached } from './firestoreReadCache';
import { geosurveyApi } from './geosurveyApi';
import { choiceAnswerToComparableString } from './choiceAnswers';
import type { Question, QuestionnaireResponse } from '../types';

const CACHE_TTL_MS = 15_000;

export function invalidateResponseIdCache(questionnaireId: string): void {
  invalidateCached(`responseId:${questionnaireId}`);
}

/** Sanitize a linked-question answer into a safe ID prefix segment. */
export function sanitizeResponseIdPrefix(raw: unknown): string {
  if (raw == null) return '';
  let text = '';
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    text = String(raw);
  } else {
    text = choiceAnswerToComparableString(raw) || '';
  }
  return text
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 32);
}

/**
 * Prefix source for a Response ID question:
 * 1. Explicit `responseIdConfig.prefixQuestionId`
 * 2. Else first question referenced by this field's display logic
 */
export function inferResponseIdPrefixQuestionId(question: Question): string | undefined {
  const explicit = question.responseIdConfig?.prefixQuestionId?.trim();
  if (explicit) return explicit;
  const logic = question.logic;
  if (!logic?.enabled || !logic.conditions?.length) return undefined;
  for (const c of logic.conditions) {
    const id = c.questionId?.trim();
    if (id) return id;
  }
  return undefined;
}

/**
 * Resolve prefix for a responseId question.
 * - `''` → no linked question (plain serial mode), ready to allocate
 * - `null` → linked question set but unanswered / empty — wait
 * - non-empty string → prefix ready
 */
export function resolveResponseIdPrefix(
  question: Question,
  answers: Record<string, unknown>,
  allQuestions: Question[]
): string | null {
  const linkedId = inferResponseIdPrefixQuestionId(question);
  if (!linkedId) return '';

  const linked = allQuestions.find((q) => q.id === linkedId);
  const raw = answers[linkedId];
  if (raw === undefined || raw === null || raw === '') return null;
  if (Array.isArray(raw) && raw.length === 0) return null;

  // Prefer stored option value for choice questions.
  if (linked && (linked.type === 'select' || linked.type === 'radio')) {
    const comparable = choiceAnswerToComparableString(raw);
    if (!comparable) return null;
    const prefix = sanitizeResponseIdPrefix(comparable);
    return prefix || null;
  }

  const prefix = sanitizeResponseIdPrefix(raw);
  return prefix || null;
}

export function formatResponseId(prefix: string, serial: number): string {
  if (!prefix) return String(serial);
  return `${prefix}-${serial}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract serial number from a stored response ID for a given prefix bucket. */
export function parseResponseIdSerial(value: unknown, prefix: string = ''): number | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!prefix) {
    // Plain serial, or accept PREFIX-N and return N when scanning loosely.
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return Number.isInteger(n) && n > 0 ? n : null;
    }
    const loose = s.match(/^(.+)-(\d+)$/);
    if (loose) {
      const n = Number(loose[2]);
      return Number.isInteger(n) && n > 0 ? n : null;
    }
    return null;
  }
  const re = new RegExp(`^${escapeRegex(prefix)}-(\\d+)$`, 'i');
  const m = s.match(re);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function responseIdMatchesPrefix(value: unknown, prefix: string): boolean {
  return parseResponseIdSerial(value, prefix) !== null;
}

export function isAllocatedResponseIdValue(value: unknown): boolean {
  if (value == null) return false;
  const s = String(value).trim();
  if (!s) return false;
  if (/^\d+$/.test(s)) return true;
  return /^.+-\d+$/.test(s);
}

function collectSerialsFromPools(
  pools: Array<Record<string, unknown> | undefined>,
  fieldIds: string[],
  prefix: string
): number[] {
  const out: number[] = [];
  const idSet = new Set(fieldIds);
  for (const pool of pools) {
    if (!pool) continue;
    for (const [k, v] of Object.entries(pool)) {
      if (idSet.size > 0 && !idSet.has(k)) {
        const seq = parseResponseIdSerial(v, prefix);
        if (seq != null) out.push(seq);
        continue;
      }
      const seq = parseResponseIdSerial(v, prefix);
      if (seq != null) out.push(seq);
    }
  }
  return out;
}

/**
 * Next serial for this enumerator × questionnaire × prefix bucket.
 * Plain mode → `1`, `2`, `3`…
 * Prefixed → `N-1`, `N-2`, …
 */
export async function allocateNextResponseId(options: {
  questionnaireId: string;
  respondentId: string;
  prefix: string;
  responseIdFieldIds: string[];
  excludeResponseId?: string;
}): Promise<string> {
  const {
    questionnaireId,
    respondentId,
    prefix,
    responseIdFieldIds,
    excludeResponseId
  } = options;

  const cacheKey = `responseId:${questionnaireId}:${respondentId}:${prefix || '_'}:${excludeResponseId || ''}`;
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
        ...collectSerialsFromPools(
          [data.responses, data.enumeratorInfo],
          responseIdFieldIds,
          prefix
        )
      );
    }
    nextSerial = serials.length > 0 ? Math.max(...serials) + 1 : 1;
  }

  // Optimistic bump so rapid consecutive opens don't reuse the same number
  // before the first save lands.
  setCached(cacheKey, nextSerial + 1);
  return formatResponseId(prefix, nextSerial);
}

/** Apply one allocated ID onto every responseId question field. */
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

/**
 * Drop accidental duplicate Response ID questions that share a key and have
 * no display logic (common when the palette fires twice). Keep the first.
 * Intentionally-branched Response IDs (enabled logic) are preserved.
 */
export function collapseAccidentalResponseIdQuestions(questions: Question[]): Question[] {
  const seenPlainKeys = new Set<string>();
  return questions.filter((q) => {
    if (q.type !== 'responseId') return true;
    const hasLogic = !!(q.logic?.enabled && (q.logic.conditions?.length ?? 0) > 0);
    if (hasLogic) return true;
    const k = (q.key || q.id || 'response_id').toLowerCase();
    if (seenPlainKeys.has(k)) return false;
    seenPlainKeys.add(k);
    return true;
  });
}

/** Read the auto Response ID value from a saved response (for list UIs). */
export function readResponseIdSerial(
  response: Pick<QuestionnaireResponse, 'responses'>,
  questions: Question[] | undefined
): string | null {
  const fieldIds = (questions || []).filter((q) => q.type === 'responseId').map((q) => q.id);
  if (fieldIds.length === 0) return null;
  const pool = response.responses || {};
  for (const id of fieldIds) {
    const v = pool[id];
    if (v != null && String(v).trim() && isAllocatedResponseIdValue(v)) {
      return String(v).trim();
    }
  }
  return null;
}
