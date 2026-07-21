/**
 * Pure evaluator for `computed` questions.
 *
 * A computed question's answer is derived from other questions' answers
 * via a `ComputedSpec` (sum, multiply, average, count, concat, or a
 * free `{{questionId}}` arithmetic expression). The evaluator runs on
 * every answer change in the live form, but also when admins preview
 * questionnaires — keeping it side-effect-free and dependency-free
 * means it can run in tests, web workers, or the response viewer too.
 *
 * Robustness:
 * - Missing / non-numeric operands are ignored for numeric ops (so
 *   "sum of age + salary" still produces a partial sum while only one
 *   of the inputs is filled). If every operand is missing, the result
 *   is `null` (rendered as empty) instead of `0` to keep the read-only
 *   UI obviously "not computed yet".
 * - `divide` by zero yields `null` rather than `Infinity` — admins
 *   reading CSV exports never see a fake `Infinity` cell.
 * - `expression` runs through a tiny token-level parser; only
 *   `+ - * / ( )` and numeric literals are accepted. Anything else
 *   short-circuits to `null`. We deliberately do NOT use `eval` /
 *   `new Function`, which would let admins (or anyone who could
 *   tamper with Firestore data) inject arbitrary JS into enumerators'
 *   devices.
 */

import { ComputedSpec, Question } from '../types';
import { normalizeBanglaDigits } from './banglaDigits';

/**
 * Coerce a stored answer into a finite number, or `null` when it
 * can't sensibly be treated as one (empty, an array, etc.). We
 * recognise the `age` object shape (`{ years, months, totalMonths }`)
 * and treat it as `years + months/12` so admins can mix ages into
 * arithmetic without writing `years*12 + months` by hand.
 */
export const coerceAnswerToNumber = (v: unknown): number | null => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const trimmed = normalizeBanglaDigits(v.trim()).replace(/,/g, '');
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  if (Array.isArray(v)) return null;
  if (typeof v === 'object') {
    const obj = v as { years?: number | string; months?: number | string };
    if (obj.years !== undefined || obj.months !== undefined) {
      const y = Number(normalizeBanglaDigits(String(obj.years ?? 0)));
      const m = Number(normalizeBanglaDigits(String(obj.months ?? 0)));
      const yy = Number.isFinite(y) ? y : 0;
      const mm = Number.isFinite(m) ? m : 0;
      return yy + mm / 12;
    }
  }
  return null;
};

const coerceAnswerToString = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map((x) => coerceAnswerToString(x)).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    const obj = v as { years?: number | string; months?: number | string };
    if (obj.years !== undefined || obj.months !== undefined) {
      const y = Number(obj.years ?? 0);
      const m = Number(obj.months ?? 0);
      const yy = Number.isFinite(y) ? y : 0;
      const mm = Number.isFinite(m) ? m : 0;
      if (yy === 0 && mm === 0) return '0 months';
      const parts: string[] = [];
      if (yy > 0) parts.push(`${yy} ${yy === 1 ? 'year' : 'years'}`);
      if (mm > 0) parts.push(`${mm} ${mm === 1 ? 'month' : 'months'}`);
      return parts.join(' ');
    }
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
};

/**
 * Resolve a placeholder name (`{{...}}` content) to the answer for
 * either a question id or a question key. We trim whitespace inside
 * the braces so admins can write `{{ q1 }}` without surprises.
 */
const resolvePlaceholder = (
  name: string,
  answers: Record<string, unknown>,
  questions: Question[]
): unknown => {
  const key = name.trim();
  if (key === '') return undefined;
  if (key in answers) return answers[key];
  const byKey = questions.find((q) => q.key === key);
  if (byKey) return answers[byKey.id];
  return undefined;
};

const round = (n: number, decimals: number | undefined): number => {
  const d = decimals === undefined || decimals < 0 ? 2 : Math.min(10, Math.floor(decimals));
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
};

// ---------------------------------------------------------------------------
// Tiny safe arithmetic evaluator (numbers, + - * / and parentheses).
// Returns null when the expression is malformed or divides by zero so the
// runtime can render the result as "empty" without exploding.
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' }
  | { kind: 'lp' }
  | { kind: 'rp' };

const tokenize = (input: string): Token[] | null => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lp' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rp' });
      i += 1;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ kind: 'op', value: ch });
      i += 1;
      continue;
    }
    // Number literal — allow integer, decimal, and unary leading minus.
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let j = i;
      let dot = ch === '.';
      while (j + 1 < input.length) {
        const next = input[j + 1];
        if (next >= '0' && next <= '9') {
          j += 1;
          continue;
        }
        if (next === '.' && !dot) {
          dot = true;
          j += 1;
          continue;
        }
        break;
      }
      const slice = input.slice(i, j + 1);
      const n = Number(slice);
      if (!Number.isFinite(n)) return null;
      tokens.push({ kind: 'num', value: n });
      i = j + 1;
      continue;
    }
    return null;
  }
  return tokens;
};

const parseExpression = (tokens: Token[]): number | null => {
  let pos = 0;

  // Treat a leading '-' or '+' as a unary sign applied to the next factor.
  const parseFactor = (): number | null => {
    if (pos >= tokens.length) return null;
    const t = tokens[pos];
    if (t.kind === 'op' && (t.value === '+' || t.value === '-')) {
      pos += 1;
      const inner = parseFactor();
      if (inner === null) return null;
      return t.value === '-' ? -inner : inner;
    }
    if (t.kind === 'num') {
      pos += 1;
      return t.value;
    }
    if (t.kind === 'lp') {
      pos += 1;
      const v = parseAddSub();
      if (v === null) return null;
      if (pos >= tokens.length || tokens[pos].kind !== 'rp') return null;
      pos += 1;
      return v;
    }
    return null;
  };

  const parseMulDiv = (): number | null => {
    let left = parseFactor();
    if (left === null) return null;
    while (pos < tokens.length) {
      const t = tokens[pos];
      if (t.kind !== 'op' || (t.value !== '*' && t.value !== '/')) break;
      pos += 1;
      const right = parseFactor();
      if (right === null) return null;
      if (t.value === '*') {
        left = left * right;
      } else {
        if (right === 0) return null;
        left = left / right;
      }
    }
    return left;
  };

  const parseAddSub = (): number | null => {
    let left = parseMulDiv();
    if (left === null) return null;
    while (pos < tokens.length) {
      const t = tokens[pos];
      if (t.kind !== 'op' || (t.value !== '+' && t.value !== '-')) break;
      pos += 1;
      const right = parseMulDiv();
      if (right === null) return null;
      left = t.value === '+' ? left + right : left - right;
    }
    return left;
  };

  const result = parseAddSub();
  if (result === null) return null;
  if (pos !== tokens.length) return null;
  return Number.isFinite(result) ? result : null;
};

const evalExpression = (
  raw: string,
  answers: Record<string, unknown>,
  questions: Question[]
): number | null => {
  // Substitute placeholders first; if any resolves to a non-number we
  // bail out with `null` rather than letting `NaN` propagate.
  let aborted = false;
  const substituted = raw.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => {
    const resolved = resolvePlaceholder(key, answers, questions);
    const num = coerceAnswerToNumber(resolved);
    if (num === null) {
      aborted = true;
      return '0';
    }
    return `(${num})`;
  });
  if (aborted) return null;
  const tokens = tokenize(substituted);
  if (!tokens) return null;
  if (tokens.length === 0) return null;
  return parseExpression(tokens);
};

// ---------------------------------------------------------------------------
// Public evaluator
// ---------------------------------------------------------------------------

export interface ComputedResult {
  /** Stored answer value (number, string, or `null` if not computable yet). */
  value: number | string | null;
  /** Pretty display string with prefix/suffix applied — what to show read-only. */
  display: string;
}

export const evaluateComputed = (
  spec: ComputedSpec | undefined,
  answers: Record<string, unknown>,
  questions: Question[]
): ComputedResult => {
  const empty: ComputedResult = { value: null, display: '' };
  if (!spec) return empty;
  const op = spec.operation;
  const operandIds = spec.operandQuestionIds ?? [];

  const formatNumber = (n: number): string => {
    const r = round(n, spec.decimals);
    const body = Number.isInteger(r) && (spec.decimals ?? 2) === 0 ? String(r) : String(r);
    return `${spec.prefix ?? ''}${body}${spec.suffix ?? ''}`;
  };

  if (op === 'expression') {
    const raw = spec.expression ?? '';
    if (!raw.trim()) return empty;
    const n = evalExpression(raw, answers, questions);
    if (n === null) return empty;
    const r = round(n, spec.decimals);
    return { value: r, display: formatNumber(r) };
  }

  if (op === 'concat') {
    const parts = operandIds
      .map((id) => coerceAnswerToString(answers[id]))
      .filter((s) => s !== '');
    if (parts.length === 0) return empty;
    const joiner = spec.separator ?? ' ';
    const joined = parts.join(joiner);
    return { value: joined, display: `${spec.prefix ?? ''}${joined}${spec.suffix ?? ''}` };
  }

  if (op === 'count_nonempty') {
    const count = operandIds.reduce((acc, id) => {
      const v = answers[id];
      if (v === undefined || v === null || v === '') return acc;
      if (Array.isArray(v) && v.length === 0) return acc;
      return acc + 1;
    }, 0);
    return { value: count, display: `${spec.prefix ?? ''}${count}${spec.suffix ?? ''}` };
  }

  // Pure numeric ops — coerce every operand and skip the empties so a
  // partially-filled form still shows a partial result.
  const numbers: number[] = [];
  for (const id of operandIds) {
    const n = coerceAnswerToNumber(answers[id]);
    if (n !== null) numbers.push(n);
  }
  if (numbers.length === 0) return empty;

  let result: number;
  switch (op) {
    case 'sum':
      result = numbers.reduce((a, b) => a + b, 0);
      break;
    case 'subtract':
      result = numbers.slice(1).reduce((a, b) => a - b, numbers[0]);
      break;
    case 'multiply':
      result = numbers.reduce((a, b) => a * b, 1);
      break;
    case 'divide':
      result = numbers.slice(1).reduce((a, b) => (b === 0 ? NaN : a / b), numbers[0]);
      break;
    case 'average':
      result = numbers.reduce((a, b) => a + b, 0) / numbers.length;
      break;
    case 'min':
      result = Math.min(...numbers);
      break;
    case 'max':
      result = Math.max(...numbers);
      break;
    default:
      return empty;
  }
  if (!Number.isFinite(result)) return empty;
  const rounded = round(result, spec.decimals);
  return { value: rounded, display: formatNumber(rounded) };
};

/** Human-friendly label for the operation, used in editor + read-only hints. */
export const computedOpLabel = (op: ComputedSpec['operation']): string => {
  switch (op) {
    case 'sum':
      return 'Sum (A + B + C …)';
    case 'subtract':
      return 'Subtract (A − B − C …)';
    case 'multiply':
      return 'Multiply (A × B × C …)';
    case 'divide':
      return 'Divide (A ÷ B ÷ C …)';
    case 'average':
      return 'Average';
    case 'min':
      return 'Minimum';
    case 'max':
      return 'Maximum';
    case 'count_nonempty':
      return 'Count of answered operands';
    case 'concat':
      return 'Concatenate text';
    case 'expression':
      return 'Custom expression';
    default:
      return op;
  }
};
