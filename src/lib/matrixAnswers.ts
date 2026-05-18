import type { Question } from '../types';

/** Normalise a stored matrix answer `{ [rowLabel]: columnValue }`. */
export const parseMatrixAnswer = (value: unknown): Record<string, string> => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, string>;
  }
  return {};
};

/** Row labels from the questionnaire definition (empty lines skipped). */
const configuredRows = (rows: string[] | undefined): string[] =>
  (rows ?? []).filter((r) => String(r).trim().length > 0);

/** True when every configured row has a selected column (হ্যাঁ / না, etc.). */
export const matrixAllRowsAnswered = (
  value: unknown,
  rows: string[] | undefined
): boolean => {
  const list = configuredRows(rows);
  if (list.length === 0) return true;
  const m = parseMatrixAnswer(value);
  // Keys must match the row label strings used in the UI (`matrixVal[r]`),
  // not trimmed variants — otherwise validation falsely fails.
  return list.every((row) => {
    const v = m[row];
    return v !== undefined && v !== null && String(v).trim() !== '';
  });
};

/**
 * Matrix / grid: every visible row must have one column selected before submit.
 * Applies to all matrix questions (not only when the global "Required" box is on).
 */
export const validateMatrixQuestion = (
  q: Pick<Question, 'type' | 'rows'>,
  value: unknown
): string | null => {
  if (q.type !== 'matrix') return null;
  const rows = configuredRows(q.rows);
  if (rows.length === 0) return null;
  if (!matrixAllRowsAnswered(value, q.rows)) {
    return 'Please select an answer for every row (হ্যাঁ or না for each item).';
  }
  return null;
};
