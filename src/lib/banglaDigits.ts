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
 * Keep only characters valid in a decimal number field, accepting Bangla
 * digits. Returns the normalized ASCII form for storage.
 */
export function sanitizeDecimalInput(raw: string): string {
  const n = normalizeBanglaDigits(raw).replace(/,/g, '');
  // Allow empty, optional leading minus, digits, one dot.
  let sign = '';
  let body = n;
  if (body.startsWith('-')) {
    sign = '-';
    body = body.slice(1);
  }
  body = body.replace(/[^\d.]/g, '');
  const dot = body.indexOf('.');
  if (dot >= 0) {
    body = body.slice(0, dot + 1) + body.slice(dot + 1).replace(/\./g, '');
  }
  return sign + body;
}

/**
 * Integer-only field (age years/months, etc.). Accepts Bangla digits.
 */
export function sanitizeIntegerInput(raw: string): string {
  return normalizeBanglaDigits(raw).replace(/[^\d]/g, '');
}

/** Parse a user-typed number that may contain Bangla digits. */
export function parseLocaleNumber(raw: string): number {
  const n = Number(normalizeBanglaDigits(String(raw).trim()).replace(/,/g, ''));
  return n;
}
