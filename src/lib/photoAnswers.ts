/**
 * Helpers for questionnaire `photo` answers.
 * Capture keeps the image dataUrl for preview/storage in the response JSON.
 * CSV / SHP downloads attach real image files under `photos/` and write
 * relative paths in the attribute cells — never the base64 payload.
 */

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
  const dataUrl = (value as PhotoAnswer).dataUrl;
  const fileName = (value as PhotoAnswer).fileName;
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

const safePathToken = (raw: string, max = 40): string =>
  String(raw || 'x')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max) || 'x';

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

/**
 * Relative path written into CSV / SHP attribute cells, e.g.
 * `photos/resp_abc123_tree_photo.jpg`
 */
export const buildPhotoExportRelativePath = (
  responseId: string,
  questionIdOrKey: string,
  value: unknown
): string | null => {
  const extracted = extractPhotoBytes(value);
  if (!extracted) {
    const label = formatPhotoAnswerLabel(value);
    return label || null;
  }
  const base = `${safePathToken(responseId, 48)}_${safePathToken(questionIdOrKey, 32)}`;
  return `photos/${base}.${extracted.ext}`;
};

export type ExportPhotoAttachment = {
  relativePath: string;
  bytes: Uint8Array;
  mimeType: string;
};

/** Register an embeddable photo and return the path for the table cell. */
export const collectResponsePhotoAttachment = (
  responseId: string,
  questionIdOrKey: string,
  value: unknown,
  into: Map<string, ExportPhotoAttachment>
): string => {
  const path = buildPhotoExportRelativePath(responseId, questionIdOrKey, value);
  if (!path) return '';
  if (!path.startsWith('photos/')) return path;
  if (!into.has(path)) {
    const extracted = extractPhotoBytes(value);
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
