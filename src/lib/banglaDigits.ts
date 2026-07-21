/**
 * Bengali (Bangla) digit helpers for survey inputs.
 * Android / iOS Bangla keyboards often insert ০–৯; HTML `type="number"`
 * rejects those, so we use text fields and normalize for parsing/storage.
 */

const BN = '০১২৩৪৫৬৭৮৯';
const EN = '0123456789';

/** Map 0–9 → ০–৯ (other characters unchanged). */
export function toBanglaDigits(input: string | number): string {
  const s = String(input);
  let out = '';
  for (const ch of s) {
    const i = EN.indexOf(ch);
    out += i >= 0 ? BN[i] : ch;
  }
  return out;
}

/** Map ০–৯ → 0–9 (other characters unchanged). */
export function normalizeBanglaDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const i = BN.indexOf(ch);
    out += i >= 0 ? EN[i] : ch;
  }
  return out;
}

/** True if the string has at least one Bengali digit. */
export function containsBanglaDigits(input: string): boolean {
  for (const ch of input) {
    if (BN.includes(ch)) return true;
  }
  return false;
}

/**
 * Keep only characters valid in a decimal number field.
 * Preserves Bangla (০–৯) or Latin digits as typed — does not force English.
 */
export function sanitizeDecimalInput(raw: string): string {
  let sign = '';
  let body = String(raw).replace(/,/g, '');
  if (body.startsWith('-') || body.startsWith('\u2212')) {
    sign = '-';
    body = body.slice(1);
  }
  // Latin digits, Bangla digits, one decimal point
  body = body.replace(/[^\d০-৯.]/g, '');
  const dot = body.indexOf('.');
  if (dot >= 0) {
    body = body.slice(0, dot + 1) + body.slice(dot + 1).replace(/\./g, '');
  }
  return sign + body;
}

/**
 * Integer-only field (age years/months, etc.).
 * Preserves Bangla or Latin digits as typed.
 */
export function sanitizeIntegerInput(raw: string): string {
  return String(raw).replace(/[^\d০-৯]/g, '');
}

/** Parse a user-typed number that may contain Bangla digits. */
export function parseLocaleNumber(raw: string): number {
  const n = Number(normalizeBanglaDigits(String(raw).trim()).replace(/,/g, ''));
  return n;
}
