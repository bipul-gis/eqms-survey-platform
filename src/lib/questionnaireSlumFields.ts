import { Question } from '../types';

const fieldHaystack = (f: Question): string =>
  `${f.key || ''} ${f.question || ''}`.toLowerCase();

export const looksLikeSlumNameField = (f: Question): boolean => {
  const hay = fieldHaystack(f);
  if (!/\bslum\b/.test(hay)) return false;
  return /\bname\b/.test(hay) || /\bনাম/.test(hay);
};

export const looksLikeDwellingIdField = (f: Question): boolean => {
  const hay = fieldHaystack(f);

  const idHit =
    /\bid\b/.test(hay) ||
    /\bnumber\b/.test(hay) ||
    /\bno\.?\b/.test(hay) ||
    /\bcode\b/.test(hay) ||
    /\bকোড/.test(hay);

  if (!idHit) return false;

  // Dwelling / household labels — include common typos (e.g. "Dewlling ID").
  const dwellingHit =
    /\bdwell/.test(hay) ||
    /\bdewll/.test(hay) ||
    /\bduell/.test(hay) ||
    /\bhouse\s*hold/.test(hay) ||
    /\bবাসস্থান/.test(hay) ||
    /\bunit\b/.test(hay);

  if (dwellingHit) return true;

  // "Dewlling ID" — dew- prefix + id, without exact "dwelling" spelling.
  if (/\bdew/.test(hay) && /\blling\b/.test(hay)) return true;

  return false;
};

export const collectSlumNameFieldIds = (fields: Question[] | undefined): string[] =>
  (fields || []).filter(looksLikeSlumNameField).map((f) => f.id);

export const collectDwellingIdFieldIds = (fields: Question[] | undefined): string[] =>
  (fields || []).filter(looksLikeDwellingIdField).map((f) => f.id);

/** Ward / Area (from slum CSV `WARDNAME`) — not slum name or dwelling id. */
export const looksLikeWardAreaField = (f: Question): boolean => {
  if (looksLikeSlumNameField(f) || looksLikeDwellingIdField(f)) return false;
  const hay = fieldHaystack(f);
  if (/\bslum\b/.test(hay)) return false;
  if (/\bdwell/.test(hay) || /\bdewll/.test(hay)) return false;

  const wardHit = /\bward\b/.test(hay) || /\bওয়ার্ড/.test(hay);
  const areaHit = /\barea\b/.test(hay) || /\bএলাকা/.test(hay);
  if (wardHit && areaHit) return true;

  // Labels like "Ward/Area" without spaces around slash.
  if (/\bward\s*\/\s*area\b/.test(hay)) return true;

  return false;
};

export const collectWardAreaFieldIds = (fields: Question[] | undefined): string[] =>
  (fields || []).filter(looksLikeWardAreaField).map((f) => f.id);
