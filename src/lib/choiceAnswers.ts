/**
 * Helpers for single-choice answers that support "Other / specify"
 * (`Question.allowOther`). Stored shape when the enumerator picks Other:
 * `{ other: true, text: string }`. Regular options stay a plain string
 * value so existing surveys and CSV exports keep working.
 */

/** `<option value>` / radio value reserved for the Other branch. */
export const OTHER_OPTION_VALUE = '__other__';
const MULTI_OTHER_TEXT_PREFIX = '__other_text__:';

export const multiChoiceValues = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && !item.startsWith(MULTI_OTHER_TEXT_PREFIX))
    : [];

export const multiChoiceHasOther = (value: unknown): boolean =>
  multiChoiceValues(value).includes(OTHER_OPTION_VALUE);

export const multiChoiceOtherText = (value: unknown): string => {
  if (!Array.isArray(value)) return '';
  const entry = value.find((item) => typeof item === 'string' && item.startsWith(MULTI_OTHER_TEXT_PREFIX));
  return typeof entry === 'string' ? entry.slice(MULTI_OTHER_TEXT_PREFIX.length) : '';
};

export const makeMultiChoiceAnswer = (values: string[], otherText = ''): string[] => {
  const unique = [...new Set(values)];
  if (unique.includes(OTHER_OPTION_VALUE) && otherText) {
    unique.push(`${MULTI_OTHER_TEXT_PREFIX}${otherText}`);
  }
  return unique;
};

export const formatMultiChoiceAnswerForExport = (value: unknown): string[] => {
  const values = multiChoiceValues(value).filter((item) => item !== OTHER_OPTION_VALUE);
  if (multiChoiceHasOther(value)) {
    const text = multiChoiceOtherText(value).trim();
    values.push(text ? `Other: ${text}` : 'Other');
  }
  return values;
};

export interface OtherSpecifyAnswer {
  other: true;
  text: string;
}

export function isOtherSpecifyAnswer(v: unknown): v is OtherSpecifyAnswer {
  return (
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    (v as OtherSpecifyAnswer).other === true &&
    typeof (v as OtherSpecifyAnswer).text === 'string'
  );
}

/** True when there is no substantive answer (including empty Other text). */
export function choiceAnswerIsEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return true;
  if (Array.isArray(v) && multiChoiceValues(v).length === 0) return true;
  if (isOtherSpecifyAnswer(v)) return v.text.trim() === '';
  return false;
}

/** Inverse of `choiceAnswerIsEmpty` — used for progress / required checks. */
export function choiceAnswerIsFilled(v: unknown): boolean {
  return !choiceAnswerIsEmpty(v);
}

/**
 * Stable string form for logic comparisons (equals / contains) and
 * `ruleValueMatchesCurrent`, so `{ other, text }` does not stringify
 * to "[object Object]".
 */
export function choiceAnswerToComparableString(v: unknown): string {
  if (isOtherSpecifyAnswer(v)) {
    return `${OTHER_OPTION_VALUE}::${v.text.trim()}`;
  }
  return String(v ?? '');
}

/** Human-readable export / admin table cell for choice + Other. */
export function formatChoiceAnswerForExport(v: unknown): string {
  if (isOtherSpecifyAnswer(v)) {
    const t = v.text.trim();
    return t.length > 0 ? `Other: ${t}` : 'Other';
  }
  return String(v ?? '');
}
