/**
 * Slum reference data from `src/data/SLUM Info.csv` (WARDNAME, SLUM_NAME, SLUMID).
 * Used for questionnaire task assignment and auto-filling slum / dwelling fields.
 */

import slumCsvRaw from '../data/SLUM Info.csv?raw';

export interface SlumRecord {
  wardName: string;
  slumName: string;
  slumId: string;
}

const parseCsvLine = (line: string): string[] => {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
};

const parseSlumCsv = (raw: string): SlumRecord[] => {
  const text = raw.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const records: SlumRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 3) continue;
    const wardName = String(cols[0] ?? '').trim();
    const slumName = String(cols[1] ?? '').trim();
    const slumId = String(cols[2] ?? '').trim();
    if (!slumName || !slumId) continue;
    records.push({ wardName, slumName, slumId });
  }
  return records;
};

const ALL_SLUMS: SlumRecord[] = parseSlumCsv(slumCsvRaw);

const byId = new Map<string, SlumRecord>();
const byNameKey = new Map<string, SlumRecord[]>();

for (const row of ALL_SLUMS) {
  byId.set(row.slumId, row);
  const key = normalizeSlumNameKey(row.slumName);
  const list = byNameKey.get(key) ?? [];
  list.push(row);
  byNameKey.set(key, list);
}

export function normalizeSlumNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function getAllSlums(): SlumRecord[] {
  return ALL_SLUMS;
}

export function findSlumById(slumId: string): SlumRecord | undefined {
  return byId.get(String(slumId).trim());
}

/** First match when names are unique; prefers exact case-insensitive name match. */
export function findSlumByName(slumName: string): SlumRecord | undefined {
  const key = normalizeSlumNameKey(slumName);
  const hits = byNameKey.get(key);
  if (!hits || hits.length === 0) return undefined;
  return hits[0];
}

export function slumDisplayLabel(row: SlumRecord): string {
  const ward = row.wardName.trim();
  const wardLabel = /^\d+$/.test(ward) ? `Ward ${ward}` : ward;
  return `${row.slumName} (${wardLabel})`;
}

/** Dwelling id format: `{SLUMID}_{n}` e.g. `20151612364_1`. */
export function formatDwellingId(slumId: string, sequence: number): string {
  return `${String(slumId).trim()}_${sequence}`;
}

export function parseDwellingSequence(value: unknown, slumId: string): number | null {
  const v = String(value ?? '').trim();
  const id = String(slumId).trim();
  if (!v || !id) return null;
  const re = new RegExp(`^${escapeRegExp(id)}_(\\d+)$`, 'i');
  const m = v.match(re);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function nextDwellingSequenceFromValues(values: unknown[], slumId: string): number {
  let max = 0;
  for (const v of values) {
    const seq = parseDwellingSequence(v, slumId);
    if (seq !== null && seq > max) max = seq;
  }
  return max + 1;
}
