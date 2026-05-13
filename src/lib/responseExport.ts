/**
 * Export helpers for survey responses.
 *
 * Output format:
 * - CSV: one row per response, columns auto-derived from the questionnaire
 *   definition (so enumerator-info fields and questions become columns).
 *   Multi-value answers are joined with `; ` inside the cell; objects fall
 *   back to compact JSON. No third-party deps — kept dependency-free so the
 *   admin bundle stays small.
 */

import {
  Question,
  QuestionOption,
  Questionnaire,
  QuestionnaireResponse
} from '../types';

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/** Best-effort conversion from any Firestore-ish timestamp into a JS Date. */
export const tsToDate = (v: unknown): Date | null => {
  if (v == null) return null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof v === 'object') {
    const anyV = v as { toDate?: () => Date; seconds?: number; nanoseconds?: number };
    if (typeof anyV.toDate === 'function') {
      try {
        return anyV.toDate();
      } catch {
        return null;
      }
    }
    if (typeof anyV.seconds === 'number') {
      return new Date(anyV.seconds * 1000 + Math.floor((anyV.nanoseconds || 0) / 1e6));
    }
  }
  return null;
};

export const fmtDate = (v: unknown): string => {
  const d = tsToDate(v);
  return d ? d.toLocaleString() : '';
};

const ensureOptions = (opts: Question['options']): QuestionOption[] => {
  if (!opts || opts.length === 0) return [];
  if (typeof opts[0] === 'string') {
    return (opts as string[]).map((s, i) => ({ id: `opt_${i}`, value: s, label: s }));
  }
  return opts as QuestionOption[];
};

/**
 * Convert a 24-hour `HH:MM` (or `HH:MM:SS`) string into 12-hour AM/PM form.
 * The native `<input type="time">` and `datetime-local` controls always emit
 * 24-hour values, so this only fires on export to make CSV/Excel output
 * human-friendly. Returns the original string if it doesn't parse.
 */
const formatTimeToAmPm = (hhmm: string): string => {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return hhmm;
  let h = parseInt(m[1], 10);
  const mm = m[2];
  if (!Number.isFinite(h) || h < 0 || h > 23) return hhmm;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${mm} ${ampm}`;
};

/** Reformat an ISO-ish "YYYY-MM-DDTHH:MM" or "YYYY-MM-DD HH:MM" string. */
const formatDateTimeToAmPm = (raw: string): string => {
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return raw;
  return `${m[1]} ${formatTimeToAmPm(`${m[2]}:${m[3]}`)}`;
};

/** Convert raw answer values into a human-readable string. */
const stringifyAnswer = (v: unknown, q?: Question): string => {
  if (v == null) return '';
  if (Array.isArray(v)) {
    if (q && ensureOptions(q.options).length > 0) {
      const opts = ensureOptions(q.options);
      return v
        .map((x) => opts.find((o) => o.value === x)?.label ?? String(x))
        .join('; ');
    }
    return v.map((x) => String(x)).join('; ');
  }
  if (typeof v === 'object') {
    // Matrix-style answers: { row: column } → "row: column; row: column"
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.every(([k, val]) => typeof k === 'string' && typeof val !== 'object')) {
      return entries.map(([k, val]) => `${k}: ${String(val ?? '')}`).join('; ');
    }
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  // Time / datetime fields are stored in 24-hour form (HTML input format).
  // Export them as 12-hour AM/PM for human readability in CSV viewers.
  if (q?.type === 'time' && typeof v === 'string') {
    return formatTimeToAmPm(v);
  }
  if (q?.type === 'datetime' && typeof v === 'string') {
    return formatDateTimeToAmPm(v);
  }
  if (q && ensureOptions(q.options).length > 0) {
    const opts = ensureOptions(q.options);
    return opts.find((o) => o.value === v)?.label ?? String(v);
  }
  return String(v);
};

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'export';

const triggerDownload = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

const csvEscape = (v: unknown): string => {
  const s = v == null ? '' : String(v);
  if (s === '') return '';
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

/**
 * Tabular representation of a set of responses — same columns, same cell
 * stringification rules used by the CSV export. Pulled out so the admin UI
 * can render an HTML "CSV preview" that always matches the file admins
 * will actually download (no drift between preview and export).
 */
export interface ResponsesTable {
  header: string[];
  rows: string[][];
}

export const buildResponsesTable = (
  q: Questionnaire,
  responses: QuestionnaireResponse[]
): ResponsesTable => {
  const enumFields = q.enumeratorInfo?.fields || [];
  const questions = (q.questions || []).filter((qq) => qq.type !== 'section');

  const header: string[] = [
    'Response ID',
    'Status',
    'Submitted At',
    'Enumerator',
    'Enumerator Email',
    'Enumerator UID',
    'Latitude',
    'Longitude',
    'Ward',
    'Consent Granted',
    'Consent Granted At',
    'Submission GPS Latitude',
    'Submission GPS Longitude',
    'Submission GPS Accuracy (m)',
    'Submission GPS Captured At',
    'Submission GPS Duration (s)',
    ...enumFields.map((f) => `Info: ${f.question || f.key || f.id}`),
    ...questions.map((qq) => qq.question || qq.key || qq.id)
  ];

  const rows: string[][] = responses.map((r) => {
    const enumValues = enumFields.map((f) =>
      stringifyAnswer(r.enumeratorInfo?.[f.id], f)
    );
    const answerValues = questions.map((qq) =>
      stringifyAnswer(r.responses?.[qq.id], qq)
    );
    const sub = r.submissionLocation;
    return [
      r.id,
      r.status,
      fmtDate(r.submittedAt),
      r.respondentName || '',
      r.respondentEmail || '',
      r.respondentId || '',
      r.location?.lat != null ? String(r.location.lat) : '',
      r.location?.lng != null ? String(r.location.lng) : '',
      r.location?.ward || '',
      r.consentGranted ? 'Yes' : 'No',
      fmtDate(r.consentGrantedAt),
      sub?.lat != null ? String(sub.lat) : '',
      sub?.lng != null ? String(sub.lng) : '',
      sub?.accuracy != null ? String(sub.accuracy) : '',
      fmtDate(sub?.capturedAt),
      sub?.durationSeconds != null ? String(sub.durationSeconds) : '',
      ...enumValues,
      ...answerValues
    ];
  });

  return { header, rows };
};

/** Build a CSV string for all responses to a questionnaire. */
export const buildResponsesCsv = (
  q: Questionnaire,
  responses: QuestionnaireResponse[]
): string => {
  const { header, rows } = buildResponsesTable(q, responses);
  const csv = [header, ...rows]
    .map((row) => row.map(csvEscape).join(','))
    .join('\r\n');

  // UTF-8 BOM so Excel opens it with the right encoding for non-ASCII text.
  return '\uFEFF' + csv;
};

export const downloadResponsesCsv = (
  q: Questionnaire,
  responses: QuestionnaireResponse[]
) => {
  const csv = buildResponsesCsv(q, responses);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const filename = `${slugify(q.title)}_responses_${Date.now()}.csv`;
  triggerDownload(blob, filename);
};
