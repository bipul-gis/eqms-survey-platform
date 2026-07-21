/**
 * Export helpers for survey responses.
 *
 * Output format:
 * - CSV: one row per response, columns auto-derived from the questionnaire
 *   definition (so enumerator-info fields and questions become columns).
 *   Matrix / grid questions expand to one column per row (selected column
 *   value per cell). Other multi-value answers use `; ` inside a single cell;
 *   unknown objects fall back to compact JSON. No third-party deps.
 */

import {
  Question,
  QuestionOption,
  Questionnaire,
  QuestionnaireResponse
} from '../types';
import { mapLabelsToDbfFieldNames } from './dbfUtf8';
import {
  formatChoiceAnswerForExport,
  isOtherSpecifyAnswer
} from '../lib/choiceAnswers';
import { formatPhotoAnswerLabel } from './photoAnswers';

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

/**
 * Render an `age` value as "X years Y months" for CSV/Excel viewers.
 * Single-segment ages drop the zero segment so the cell stays readable
 * (`"5 years"` instead of `"5 years 0 months"`).
 */
const stringifyAge = (v: unknown): string => {
  if (!v || typeof v !== 'object') return '';
  const obj = v as { years?: number | string; months?: number | string };
  const y = Number(obj.years ?? 0);
  const m = Number(obj.months ?? 0);
  const yy = Number.isFinite(y) ? y : 0;
  const mm = Number.isFinite(m) ? m : 0;
  if (yy === 0 && mm === 0) return '0 months';
  const parts: string[] = [];
  if (yy > 0) parts.push(`${yy} ${yy === 1 ? 'year' : 'years'}`);
  if (mm > 0) parts.push(`${mm} ${mm === 1 ? 'month' : 'months'}`);
  return parts.join(' ');
};

/** Convert raw answer values into a human-readable string. */
const stringifyAnswer = (v: unknown, q?: Question): string => {
  if (v == null) return '';
  // Photo answers store a dataUrl for preview — never dump base64 into CSV.
  if (q?.type === 'photo') {
    return formatPhotoAnswerLabel(v);
  }
  // Age objects need a custom serializer — the generic object branch
  // below would otherwise emit `years: 3; months: 5` which is fine but
  // less natural than "3 years 5 months" in spreadsheets.
  if (q?.type === 'age' && typeof v === 'object' && !Array.isArray(v)) {
    return stringifyAge(v);
  }
  if (
    q?.type === 'location' &&
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as { lat?: unknown }).lat === 'number' &&
    typeof (v as { lng?: unknown }).lng === 'number'
  ) {
    const loc = v as { lat: number; lng: number; accuracy?: number };
    const acc =
      typeof loc.accuracy === 'number' && Number.isFinite(loc.accuracy)
        ? ` (±${loc.accuracy.toFixed(1)} m)`
        : '';
    return `${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}${acc}`;
  }
  // Computed answers are stored as raw numbers/strings. Re-apply the
  // admin-authored prefix/suffix so the CSV reads the same as what the
  // enumerator saw on screen (e.g. "BDT 1200" instead of "1200").
  if (q?.type === 'computed' && (typeof v === 'number' || typeof v === 'string')) {
    if (v === '' || v === null) return '';
    const prefix = q.computed?.prefix ?? '';
    const suffix = q.computed?.suffix ?? '';
    return `${prefix}${String(v)}${suffix}`;
  }
  if (isOtherSpecifyAnswer(v)) {
    return formatChoiceAnswerForExport(v);
  }
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
    if (
      typeof (v as { dataUrl?: unknown }).dataUrl === 'string' &&
      String((v as { dataUrl: string }).dataUrl).startsWith('data:image')
    ) {
      return formatPhotoAnswerLabel(v);
    }
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

/** One exported column: whole question, or one matrix row as its own column. */
type ResponsesExportColumn =
  | { kind: 'question'; question: Question }
  | { kind: 'matrixRow'; question: Question; row: string };

/**
 * Survey questions in the same order enumerators see them: each top-level
 * question (by builder order), then its sub-questions. Section breaks are
 * omitted — they carry no answers.
 */
export const getExportOrderedQuestions = (questionnaire: Questionnaire): Question[] => {
  const all = questionnaire.questions || [];
  const ordered: Question[] = [];
  const seen = new Set<string>();

  const push = (q: Question) => {
    if (q.type === 'section' || seen.has(q.id)) return;
    seen.add(q.id);
    ordered.push(q);
  };

  for (const q of all.filter((x) => !x.parentId)) {
    push(q);
    if (q.type === 'section') continue;
    for (const child of all.filter((c) => c.parentId === q.id)) {
      push(child);
    }
  }
  for (const q of all) {
    push(q);
  }
  return ordered;
};

/** Include answer keys from responses whose question was removed from the form. */
const mergeQuestionsWithResponseKeys = (
  ordered: Question[],
  responses: QuestionnaireResponse[]
): Question[] => {
  const known = new Set(ordered.map((q) => q.id));
  const orphanIds = new Set<string>();
  for (const r of responses) {
    if (!r.responses) continue;
    for (const id of Object.keys(r.responses)) {
      if (!known.has(id)) orphanIds.add(id);
    }
  }
  if (orphanIds.size === 0) return ordered;
  const orphans: Question[] = [...orphanIds].sort().map((id) => ({
    id,
    type: 'text',
    question: `${id} (removed from questionnaire)`,
    required: false
  }));
  return [...ordered, ...orphans];
};

const exportLatLng = (r: QuestionnaireResponse): { lat: string; lng: string } => {
  const sub = r.submissionLocation;
  const lat =
    r.location?.lat ??
    (sub?.lat != null && Number.isFinite(sub.lat) ? sub.lat : undefined);
  const lng =
    r.location?.lng ??
    (sub?.lng != null && Number.isFinite(sub.lng) ? sub.lng : undefined);
  return {
    lat: lat != null ? String(lat) : '',
    lng: lng != null ? String(lng) : ''
  };
};

/** WGS84 point for shapefile export — same lat/lng rules as CSV columns. */
export const responsePointForShp = (r: QuestionnaireResponse): [number, number] | null => {
  const { lat, lng } = exportLatLng(r);
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  return [ln, la];
};

const buildResponsesExportColumns = (questions: Question[]): ResponsesExportColumn[] => {
  const cols: ResponsesExportColumn[] = [];
  for (const qq of questions) {
    if (qq.type === 'matrix' && Array.isArray(qq.rows) && qq.rows.length > 0) {
      for (const row of qq.rows) {
        cols.push({ kind: 'matrixRow', question: qq, row });
      }
    } else {
      cols.push({ kind: 'question', question: qq });
    }
  }
  return cols;
};

const responsesExportColumnHeader = (col: ResponsesExportColumn): string => {
  if (col.kind === 'question') {
    const qq = col.question;
    return qq.question || qq.key || qq.id;
  }
  const qq = col.question;
  const base = qq.question || qq.key || qq.id;
  return `${base} — ${col.row}`;
};

const responsesExportColumnCell = (
  col: ResponsesExportColumn,
  r: QuestionnaireResponse
): string => {
  const raw = r.responses?.[col.question.id];
  if (col.kind === 'question') {
    return stringifyAnswer(raw, col.question);
  }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return '';
  const cell = (raw as Record<string, unknown>)[col.row];
  if (cell == null) return '';
  return String(cell);
};

export const slugifyExportBasename = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'export';

const slugify = slugifyExportBasename;

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
  const questions = mergeQuestionsWithResponseKeys(
    getExportOrderedQuestions(q),
    responses
  );
  const exportColumns = buildResponsesExportColumns(questions);

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
    ...exportColumns.map(responsesExportColumnHeader)
  ];

  const rows: string[][] = responses.map((r) => {
    const enumValues = enumFields.map((f) =>
      stringifyAnswer(r.enumeratorInfo?.[f.id], f)
    );
    const answerValues = exportColumns.map((col) => responsesExportColumnCell(col, r));
    const sub = r.submissionLocation;
    const { lat: exportLat, lng: exportLng } = exportLatLng(r);
    return [
      r.id,
      r.status,
      fmtDate(r.submittedAt),
      r.respondentName || '',
      r.respondentEmail || '',
      r.respondentId || '',
      exportLat,
      exportLng,
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

/** How one export column maps to questionnaire / system data. */
export type ResponsesExportFieldDescriptor = {
  /** Full column title in CSV export and GeoJSON properties before DBF rename. */
  csvHeader: string;
  sourceType: 'system' | 'enumerator_info' | 'question' | 'matrix_row';
  questionId?: string;
  fieldKey?: string;
  sourceDetail: string;
};

const SYSTEM_EXPORT_FIELDS: ResponsesExportFieldDescriptor[] = [
  { csvHeader: 'Response ID', sourceType: 'system', sourceDetail: 'Firestore response document id' },
  { csvHeader: 'Status', sourceType: 'system', sourceDetail: 'draft | submitted | reviewed' },
  { csvHeader: 'Submitted At', sourceType: 'system', sourceDetail: 'Submission timestamp' },
  { csvHeader: 'Enumerator', sourceType: 'system', sourceDetail: 'Respondent display name' },
  { csvHeader: 'Enumerator Email', sourceType: 'system', sourceDetail: 'Respondent email' },
  { csvHeader: 'Enumerator UID', sourceType: 'system', sourceDetail: 'Firebase Auth uid (respondentId)' },
  { csvHeader: 'Latitude', sourceType: 'system', sourceDetail: 'Export lat: location.lat or submissionLocation.lat' },
  { csvHeader: 'Longitude', sourceType: 'system', sourceDetail: 'Export lng: location.lng or submissionLocation.lng' },
  { csvHeader: 'Ward', sourceType: 'system', sourceDetail: 'location.ward when present' },
  { csvHeader: 'Consent Granted', sourceType: 'system', sourceDetail: 'Yes / No' },
  { csvHeader: 'Consent Granted At', sourceType: 'system', sourceDetail: 'consentGrantedAt' },
  {
    csvHeader: 'Submission GPS Latitude',
    sourceType: 'system',
    sourceDetail: 'submissionLocation.lat'
  },
  {
    csvHeader: 'Submission GPS Longitude',
    sourceType: 'system',
    sourceDetail: 'submissionLocation.lng'
  },
  {
    csvHeader: 'Submission GPS Accuracy (m)',
    sourceType: 'system',
    sourceDetail: 'submissionLocation.accuracy (meters)'
  },
  {
    csvHeader: 'Submission GPS Captured At',
    sourceType: 'system',
    sourceDetail: 'submissionLocation.capturedAt'
  },
  {
    csvHeader: 'Submission GPS Duration (s)',
    sourceType: 'system',
    sourceDetail: 'submissionLocation.durationSeconds'
  }
];

/**
 * Ordered list of export columns: system metadata, enumerator info, then
 * survey questions (matrix → one column per row label).
 */
export const buildResponsesExportFieldDescriptors = (
  q: Questionnaire,
  responses: QuestionnaireResponse[]
): ResponsesExportFieldDescriptor[] => {
  const enumFields = q.enumeratorInfo?.fields || [];
  const questions = mergeQuestionsWithResponseKeys(getExportOrderedQuestions(q), responses);
  const exportColumns = buildResponsesExportColumns(questions);
  const out: ResponsesExportFieldDescriptor[] = [...SYSTEM_EXPORT_FIELDS];

  for (const f of enumFields) {
    const label = f.question || f.key || f.id;
    out.push({
      csvHeader: `Info: ${label}`,
      sourceType: 'enumerator_info',
      questionId: f.id,
      fieldKey: f.key,
      sourceDetail: `Enumerator info field: ${label}`
    });
  }

  for (const col of exportColumns) {
    if (col.kind === 'question') {
      const qq = col.question;
      const label = qq.question || qq.key || qq.id;
      out.push({
        csvHeader: label,
        sourceType: 'question',
        questionId: qq.id,
        fieldKey: qq.key,
        sourceDetail: `Question type "${qq.type}": ${label}`
      });
    } else {
      const qq = col.question;
      const base = qq.question || qq.key || qq.id;
      out.push({
        csvHeader: `${base} — ${col.row}`,
        sourceType: 'matrix_row',
        questionId: qq.id,
        fieldKey: qq.key,
        sourceDetail: `Matrix question "${base}", row label: ${col.row}`
      });
    }
  }

  return out;
};

export type ResponsesShpFieldMappingRow = ResponsesExportFieldDescriptor & {
  /** dBase III field name inside the .dbf (max 8 characters, A–Z 0–9 _). */
  shpDbfField: string;
};

/** CSV/SHP column label → shortened DBF field name used in the shapefile. */
export const buildResponsesShpFieldMapping = (
  q: Questionnaire,
  responses: QuestionnaireResponse[]
): ResponsesShpFieldMappingRow[] => {
  const descriptors = buildResponsesExportFieldDescriptors(q, responses);
  const dbfMap = mapLabelsToDbfFieldNames(descriptors.map((d) => d.csvHeader));
  return descriptors.map((d) => ({
    ...d,
    shpDbfField: dbfMap.get(d.csvHeader) ?? d.csvHeader
  }));
};

/** UTF-8 CSV lookup table bundled inside the SHP ZIP download. */
export const buildResponsesShpFieldMappingCsv = (
  q: Questionnaire,
  responses: QuestionnaireResponse[]
): string => {
  const mapping = buildResponsesShpFieldMapping(q, responses);
  const header = [
    'CSV_Column_Label',
    'SHP_DBF_Field_8char',
    'Source_Type',
    'Question_ID',
    'Field_Key',
    'Source_Detail'
  ];
  const lines = mapping.map((r) =>
    [
      csvEscape(r.csvHeader),
      csvEscape(r.shpDbfField),
      csvEscape(r.sourceType),
      csvEscape(r.questionId ?? ''),
      csvEscape(r.fieldKey ?? ''),
      csvEscape(r.sourceDetail)
    ].join(',')
  );
  return '\uFEFF' + [header.join(','), ...lines].join('\r\n');
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
