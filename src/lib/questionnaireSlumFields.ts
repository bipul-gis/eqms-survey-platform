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
  const dwellingHit = /\bdwelling\b/.test(hay) || /\bবাসস্থান/.test(hay);
  const idHit = /\bid\b/.test(hay) || /\bnumber\b/.test(hay) || /\bno\b/.test(hay);
  return dwellingHit && idHit;
};

export const collectSlumNameFieldIds = (fields: Question[] | undefined): string[] =>
  (fields || []).filter(looksLikeSlumNameField).map((f) => f.id);

export const collectDwellingIdFieldIds = (fields: Question[] | undefined): string[] =>
  (fields || []).filter(looksLikeDwellingIdField).map((f) => f.id);
