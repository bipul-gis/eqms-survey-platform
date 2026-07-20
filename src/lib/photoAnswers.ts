/**
 * Helpers for questionnaire `photo` answers.
 * Capture still keeps the image dataUrl for preview; CSV / admin tables
 * only show a short filename — never the base64 payload.
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
    return value.startsWith('data:image') || value.startsWith('blob:') || /\.(jpe?g|png|webp|gif)$/i.test(value);
  }
  if (!value || typeof value !== 'object') return false;
  const dataUrl = (value as PhotoAnswer).dataUrl;
  const fileName = (value as PhotoAnswer).fileName;
  return (
    (typeof dataUrl === 'string' && dataUrl.length > 0) ||
    (typeof fileName === 'string' && fileName.trim().length > 0)
  );
};

/** Short label for admin tables, CSV, and SHP attribute export. */
export const formatPhotoAnswerLabel = (value: unknown): string => {
  if (value == null || value === '') return '';
  if (typeof value === 'string') {
    if (value.startsWith('data:image') || value.startsWith('blob:')) return 'photo.jpg';
    const trimmed = value.trim();
    if (!trimmed) return '';
    // Already a short name
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
