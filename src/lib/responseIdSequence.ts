import { getCached, invalidateCached, setCached } from './firestoreReadCache';
import { geosurveyApi } from './geosurveyApi';
import {
  choiceAnswerToComparableString,
  isOtherSpecifyAnswer
} from './choiceAnswers';
import { normalizeBanglaDigits, toBanglaDigits } from './banglaDigits';
import type { Question, QuestionOption, QuestionnaireResponse } from '../types';

const CACHE_TTL_MS = 15_000;

export function invalidateResponseIdCache(questionnaireId: string): void {
  invalidateCached(`responseId:${questionnaireId}`);
}

function optionList(q: Question | undefined): QuestionOption[] {
  if (!q?.options) return [];
  return q.options.map((o, i) =>
    typeof o === 'string'
      ? { id: `o_${i}`, value: o, label: o }
      : o
  );
}

/**
 * Shorten an option label into a stable ID prefix token.
 * Examples:
 *   "একক গাছ"              → "একক"
 *   "বৃক্ষগুচ্ছ (ক্যানোপি)" → "বৃক্ষগুচ্ছ"
 *   "North Zone"            → "North"
 */
export function shortenOptionLabelForPrefix(label: string): string {
  let s = String(label).trim();
  // Drop parenthetical / bracketed notes
  s = s.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ').trim();
  // First whitespace-separated token (universal for Bangla + English)
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  return parts[0];
}

/** Sanitize a prefix token — keep letters from any script, digits, underscore. */
export function sanitizeResponseIdPrefix(raw: unknown): string {
  if (raw == null) return '';
  let text = '';
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    text = String(raw);
  } else if (isOtherSpecifyAnswer(raw)) {
    text = raw.text.trim();
  } else {
    text = choiceAnswerToComparableString(raw) || '';
  }
  const cleaned = text
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/_+/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 48);
  if (!cleaned || /^[_-]+$/.test(cleaned)) return '';
  return cleaned;
}

/**
 * Prefix source question:
 * 1. Explicit `responseIdConfig.prefixQuestionId`
 * 2. Else first question referenced by this field's display logic
 *    (universal: show-when-option-equals → that option becomes the prefix)
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

/** Resolve human label for the current answer of a linked choice question. */
function resolveLinkedAnswerLabel(
  linked: Question | undefined,
  raw: unknown
): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (Array.isArray(raw) && raw.length === 0) return null;

  if (isOtherSpecifyAnswer(raw)) {
    const t = raw.text.trim();
    return t || null;
  }

  const comparable = choiceAnswerToComparableString(raw);
  if (!comparable) return null;

  if (linked && (linked.type === 'select' || linked.type === 'radio' || linked.type === 'checkbox' || linked.type === 'multiselect')) {
    const opts = optionList(linked);
    const hit =
      opts.find((o) => o.value === comparable) ||
      opts.find((o) => o.label === comparable);
    if (hit) return (hit.label || hit.value || '').trim() || null;
  }

  return comparable;
}

/**
 * Resolve prefix for a responseId / Auto Serial question.
 * - `''` → no linked question (plain serial), ready to allocate
 * - `null` → linked question set but unanswered — wait
 * - non-empty → prefix ready (e.g. "একক", "বৃক্ষগুচ্ছ")
 */
export function resolveResponseIdPrefix(
  question: Question,
  answers: Record<string, unknown>,
  allQuestions: Question[]
): string | null {
  const linkedId = inferResponseIdPrefixQuestionId(question);
  if (!linkedId) return '';

  const linked = allQuestions.find((q) => q.id === linkedId);
  const label = resolveLinkedAnswerLabel(linked, answers[linkedId]);
  if (!label) return null;

  const shortened = shortenOptionLabelForPrefix(label);
  const prefix = sanitizeResponseIdPrefix(shortened);
  return prefix || null;
}

/** True when the string contains Bengali script letters (not only digits). */
function prefixUsesBanglaScript(prefix: string): boolean {
  return /[\u0980-\u09FF]/.test(prefix);
}

/**
 * Format allocated id.
 * Plain → `1` / `১` (Latin if no Bangla context)
 * Prefixed → `একক_১`, `বৃক্ষগুচ্ছ_২`, `North_1`
 */
export function formatResponseId(prefix: string, serial: number): string {
  const useBn = prefixUsesBanglaScript(prefix);
  const serialText = useBn ? toBanglaDigits(serial) : String(serial);
  if (!prefix) return serialText;
  return `${prefix}_${serialText}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract serial number from a stored response ID for a given prefix bucket. */
export function parseResponseIdSerial(value: unknown, prefix: string = ''): number | null {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;

  const parseTail = (tail: string): number | null => {
    const ascii = normalizeBanglaDigits(tail);
    if (!/^\d+$/.test(ascii)) return null;
    const n = Number(ascii);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  if (!prefix) {
    // Plain serial (Latin or Bangla digits)
    const plain = parseTail(s);
    if (plain != null) return plain;
    // Legacy / prefixed leftovers when scanning without a known prefix
    const loose = s.match(/^(.+)[_-]([\d০-৯]+)$/u);
    if (loose) return parseTail(loose[2]);
    return null;
  }

  // Prefer underscore (current), also accept legacy hyphen
  const re = new RegExp(
    `^${escapeRegex(prefix)}[_-]([\\d০-৯]+)$`,
    'u'
  );
  const m = s.match(re);
  if (!m) return null;
  return parseTail(m[1]);
}

export function responseIdMatchesPrefix(value: unknown, prefix: string): boolean {
  return parseResponseIdSerial(value, prefix) !== null;
}

export function isAllocatedResponseIdValue(value: unknown): boolean {
  if (value == null) return false;
  const s = String(value).trim();
  if (!s) return false;
  if (parseResponseIdSerial(s, '') != null) return true;
  return /^.+[_-][\d০-৯]+$/u.test(s);
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
 * Plain → `1`…
 * Prefixed Bangla option → `একক_১`, `একক_২`…
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
 * no display logic. Intentionally-branched Response IDs are preserved.
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
