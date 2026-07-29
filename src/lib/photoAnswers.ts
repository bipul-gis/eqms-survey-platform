/**
 * Helpers for questionnaire `photo` answers.
 * Capture keeps the image dataUrl for preview/storage in the response JSON.
 * CSV / SHP downloads attach real image files under `photos/{typeFolder}/`
 * with names `enumeratorId_enumeratorName_responseId_serial.ext`.
 *
 * Type folders are resolved generically from the parent choice answer that
 * gates the photo (display logic), or from the Auto Serial prefix parent —
 * not hard-coded to any one survey.
 */

import type { Question, QuestionnaireResponse } from '../types';
import {
  readResponseIdSerial,
  resolveResponseIdPrefix,
  sanitizeResponseIdPrefix,
  shortenOptionLabelForPrefix
} from './responseIdSequence';
import {
  choiceAnswerToComparableString,
  isOtherSpecifyAnswer
} from './choiceAnswers';

export type PhotoAnswer = {
  dataUrl: string;
  mimeType: string;
  capturedAt: string;
  source: 'camera' | 'gallery';
  /** Short label for tables / CSV (e.g. photo_camera.jpg). */
  fileName: string;
  width?: number;
  height?: number;
};

const extFromMime = (mimeType?: string): string => {
  const m = String(mimeType || '').toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'jpg';
};

export const buildPhotoFileName = (
  source: 'camera' | 'gallery' = 'camera',
  mimeType = 'image/jpeg'
): string => `photo_${source}.${extFromMime(mimeType)}`;

export const isPhotoAnswerFilled = (value: unknown): boolean => {
  if (typeof value === 'string') {
    return (
      value.startsWith('data:image') ||
      value.startsWith('blob:') ||
      /\.(jpe?g|png|webp|gif)$/i.test(value)
    );
  }
  if (!value || typeof value !== 'object') return false;
  const o = value as PhotoAnswer & { hasPhoto?: boolean; _photo?: boolean };
  if (o.hasPhoto === true || o._photo === true) return true;
  const dataUrl = o.dataUrl;
  const fileName = o.fileName;
  return (
    (typeof dataUrl === 'string' && dataUrl.length > 0) ||
    (typeof fileName === 'string' && fileName.trim().length > 0)
  );
};

/** Short label for admin tables / on-screen CSV preview (no attached files). */
export const formatPhotoAnswerLabel = (value: unknown): string => {
  if (value == null || value === '') return '';
  if (typeof value === 'string') {
    if (value.startsWith('data:image') || value.startsWith('blob:')) return 'photo.jpg';
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (trimmed.length <= 80 && !trimmed.includes('base64')) return trimmed;
    return 'photo.jpg';
  }
  if (typeof value !== 'object') return '';
  const o = value as Partial<PhotoAnswer>;
  if (typeof o.fileName === 'string' && o.fileName.trim()) return o.fileName.trim();
  if (!isPhotoAnswerFilled(value)) return '';
  const source = o.source === 'gallery' ? 'gallery' : 'camera';
  return buildPhotoFileName(source, o.mimeType || 'image/jpeg');
};

/**
 * Keep Unicode letters/marks (Bangla) + digits for folder/file tokens.
 * Spaces → underscore; drop path separators and punctuation.
 */
export const safePhotoPathToken = (raw: string, max = 64): string => {
  const cleaned = String(raw || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/[^\p{L}\p{M}\p{N}_\-\u200C\u200D]/gu, '')
    .replace(/_+/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, max);
  return cleaned || 'x';
};

/** Decode a stored photo answer into raw bytes for ZIP attachment. */
export const extractPhotoBytes = (
  value: unknown
): { bytes: Uint8Array; ext: string; mimeType: string } | null => {
  let dataUrl = '';
  let mimeType = 'image/jpeg';

  if (typeof value === 'string' && value.startsWith('data:image')) {
    dataUrl = value;
  } else if (value && typeof value === 'object') {
    const o = value as Partial<PhotoAnswer>;
    if (typeof o.dataUrl === 'string' && o.dataUrl.startsWith('data:image')) {
      dataUrl = o.dataUrl;
      if (typeof o.mimeType === 'string' && o.mimeType) mimeType = o.mimeType;
    }
  }
  if (!dataUrl) return null;

  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const header = dataUrl.slice(0, comma);
  const b64 = dataUrl.slice(comma + 1);
  const mimeMatch = /^data:([^;]+)/i.exec(header);
  if (mimeMatch?.[1]) mimeType = mimeMatch[1];

  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { bytes, ext: extFromMime(mimeType), mimeType };
  } catch {
    return null;
  }
};

function optionList(q: Question | undefined): { value: string; label: string }[] {
  if (!q?.options) return [];
  return q.options.map((o, i) =>
    typeof o === 'string' ? { value: o, label: o } : { value: o.value, label: o.label || o.value || `o${i}` }
  );
}

/** Resolve the human label for a linked choice answer (option label preferred). */
function resolveChoiceAnswerLabel(linked: Question | undefined, raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (Array.isArray(raw) && raw.length === 0) return null;

  if (isOtherSpecifyAnswer(raw)) {
    const t = raw.text.trim();
    return t || null;
  }

  const comparable = choiceAnswerToComparableString(raw);
  if (!comparable) return null;

  if (
    linked &&
    (linked.type === 'select' ||
      linked.type === 'radio' ||
      linked.type === 'checkbox' ||
      linked.type === 'multiselect')
  ) {
    const opts = optionList(linked);
    const hit =
      opts.find((o) => o.value === comparable) || opts.find((o) => o.label === comparable);
    if (hit) return (hit.label || hit.value || '').trim() || null;
  }

  // Multi-select: use first selected label
  if (Array.isArray(raw) && linked) {
    const opts = optionList(linked);
    const labels = raw
      .map((v) => {
        const c = choiceAnswerToComparableString(v);
        const hit = opts.find((o) => o.value === c) || opts.find((o) => o.label === c);
        return (hit?.label || hit?.value || c || '').trim();
      })
      .filter(Boolean);
    if (labels.length > 0) return labels[0];
  }

  return comparable;
}

/** True when a label/value is a binary yes/no style answer (not a survey type). */
function isYesNoStyleToken(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  if (!s) return false;
  return /^(yes|no|y|n|true|false|হ্যাঁ|হাঁ|না|ok|okay)$/i.test(s);
}

function isYesNoChoiceQuestion(q: Question | undefined): boolean {
  if (!q) return false;
  if (
    q.type !== 'select' &&
    q.type !== 'radio' &&
    q.type !== 'checkbox' &&
    q.type !== 'multiselect'
  ) {
    return false;
  }
  const opts = optionList(q);
  if (opts.length === 0 || opts.length > 3) return false;
  const ynCount = opts.filter(
    (o) => isYesNoStyleToken(o.label || '') || isYesNoStyleToken(o.value || '')
  ).length;
  // Treat as yes/no when every option is yes/no-like (হ্যাঁ/না, Yes/No, …).
  return ynCount === opts.length;
}

/** If Auto Serial is `একক_১` / `North_12`, return the type prefix folder. */
function folderFromStoredAutoSerial(auto: string): string {
  const s = String(auto || '').trim();
  if (!s) return '';
  const m = s.match(/^(.+)_([\d\u09E6-\u09EF]+)$/u);
  if (!m) return '';
  const prefix = sanitizeResponseIdPrefix(m[1]);
  if (!prefix || isYesNoStyleToken(prefix)) return '';
  return prefix;
}

/**
 * Infer the "survey type" / branch folder for a photo (generic):
 *
 * Prefer the same parent used for Auto Serial (e.g. জরিপের ধরণ → একক /
 * বৃক্ষগুচ্ছ). Never use yes/no (হ্যাঁ/না) answers as folder names.
 *
 * 1. Auto Serial prefix parent / stored Auto Serial prefix
 * 2. Photo display-logic parents that are not yes/no questions
 * 3. Most-referenced non-yes/no choice parent in the questionnaire
 * 4. Else empty → files under `photos/` directly
 */
export function resolvePhotoTypeFolder(
  photoQuestion: Question | undefined,
  answers: Record<string, unknown>,
  allQuestions: Question[]
): string {
  const toFolder = (label: string | null | undefined): string => {
    if (!label) return '';
    const shortened = shortenOptionLabelForPrefix(label);
    const folder = sanitizeResponseIdPrefix(shortened) || safePhotoPathToken(shortened);
    if (!folder || isYesNoStyleToken(folder)) return '';
    return folder;
  };

  // 1a. Auto Serial prefix (canonical survey-type branch)
  for (const q of allQuestions) {
    if (q.type !== 'responseId') continue;
    const prefix = resolveResponseIdPrefix(q, answers, allQuestions);
    if (prefix && !isYesNoStyleToken(prefix)) return prefix;
  }

  // 1b. Derive from stored Auto Serial value (e.g. একক_১ → একক)
  const storedAuto = readResponseIdSerial({ responses: answers }, allQuestions);
  if (storedAuto) {
    const fromSerial = folderFromStoredAutoSerial(storedAuto);
    if (fromSerial) return fromSerial;
  }

  // 2. This photo's display-logic parents — skip yes/no gates
  if (photoQuestion?.logic?.enabled && photoQuestion.logic.conditions?.length) {
    for (const c of photoQuestion.logic.conditions) {
      const parentId = c.questionId?.trim();
      if (!parentId) continue;
      const parent = allQuestions.find((q) => q.id === parentId);
      if (isYesNoChoiceQuestion(parent)) continue;
      const label = resolveChoiceAnswerLabel(parent, answers[parentId]);
      const folder = toFolder(label);
      if (folder) return folder;
    }
  }

  // 3. Most-referenced non-yes/no choice parent (branch root)
  const refCounts = new Map<string, number>();
  for (const q of allQuestions) {
    if (!q.logic?.enabled || !q.logic.conditions?.length) continue;
    for (const c of q.logic.conditions) {
      const id = c.questionId?.trim();
      if (!id) continue;
      refCounts.set(id, (refCounts.get(id) || 0) + 1);
    }
  }
  const ranked = [...refCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [parentId] of ranked) {
    const parent = allQuestions.find((q) => q.id === parentId);
    if (
      !parent ||
      (parent.type !== 'select' &&
        parent.type !== 'radio' &&
        parent.type !== 'checkbox' &&
        parent.type !== 'multiselect')
    ) {
      continue;
    }
    if (isYesNoChoiceQuestion(parent)) continue;
    const label = resolveChoiceAnswerLabel(parent, answers[parentId]);
    const folder = toFolder(label);
    if (folder) return folder;
  }

  return '';
}

/** Prefer Auto Serial value; fall back to submission document id. */
export function resolvePhotoResponseIdToken(
  response: Pick<QuestionnaireResponse, 'id' | 'responses'>,
  questions: Question[]
): string {
  const auto = readResponseIdSerial(response, questions);
  if (auto) return safePhotoPathToken(auto, 72);
  return safePhotoPathToken(response.id || 'response', 48);
}

export type PhotoExportNamingContext = {
  response: Pick<
    QuestionnaireResponse,
    'id' | 'respondentId' | 'respondentName' | 'responses' | 'enumeratorInfo'
  >;
  /** Photo question (or enumerator-info photo field). */
  photoQuestion?: Question;
  allQuestions: Question[];
  /** 1-based photo index within this response for uniqueness. */
  photoSerial: number;
  value: unknown;
  /** Optional disambiguator if two photos collide on the same path. */
  questionKey?: string;
};

/**
 * Build relative ZIP path, e.g.
 * `photos/একক/uid_Rahim_একক_১_1.jpg`
 * or without branch: `photos/uid_Rahim_resp123_1.jpg`
 */
export function buildPhotoExportRelativePath(
  ctx: PhotoExportNamingContext
): string | null {
  const extracted = extractPhotoBytes(ctx.value);
  if (!extracted) {
    const label = formatPhotoAnswerLabel(ctx.value);
    return label || null;
  }

  const typeFolder = resolvePhotoTypeFolder(
    ctx.photoQuestion,
    ctx.response.responses || {},
    ctx.allQuestions
  );

  const enumeratorId = safePhotoPathToken(
    ctx.response.respondentId || 'enumerator',
    48
  );
  const enumeratorName = safePhotoPathToken(
    ctx.response.respondentName || 'unknown',
    48
  );
  const responseId = resolvePhotoResponseIdToken(ctx.response, ctx.allQuestions);
  const serial = String(Math.max(1, Math.floor(ctx.photoSerial) || 1));

  let base = `${enumeratorId}_${enumeratorName}_${responseId}_${serial}`;
  if (ctx.questionKey) {
    // Only append key on demand (collision handling)
  }
  base = safePhotoPathToken(base, 180);

  const fileName = `${base}.${extracted.ext}`;
  if (typeFolder) {
    return `photos/${typeFolder}/${fileName}`;
  }
  return `photos/${fileName}`;
}

export type ExportPhotoAttachment = {
  relativePath: string;
  bytes: Uint8Array;
  mimeType: string;
};

/** Register an embeddable photo and return the path for the table cell. */
export const collectResponsePhotoAttachment = (
  ctx: PhotoExportNamingContext,
  into: Map<string, ExportPhotoAttachment>
): string => {
  let path = buildPhotoExportRelativePath(ctx);
  if (!path) return '';
  if (!path.startsWith('photos/')) return path;

  if (into.has(path) && ctx.questionKey) {
    // Collision: append question key before extension
    const extracted = extractPhotoBytes(ctx.value);
    if (extracted) {
      const withoutExt = path.replace(/\.[^.]+$/, '');
      path = `${withoutExt}_${safePhotoPathToken(ctx.questionKey, 24)}.${extracted.ext}`;
    }
  }

  if (!into.has(path)) {
    const extracted = extractPhotoBytes(ctx.value);
    if (extracted) {
      into.set(path, {
        relativePath: path,
        bytes: extracted.bytes,
        mimeType: extracted.mimeType
      });
    }
  }
  return path;
};
