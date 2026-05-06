/**
 * dBase III DBF buffer with UTF-8 string fields (replaces @mapbox/shp-write's dbf, which
 * writes charCodeAt & 0xff and corrupts Bangla and other non-Latin text).
 * Pair with a .cpg file containing "UTF-8" for ArcGIS / QGIS.
 */

import JSZip from 'jszip';

const MAX_FIELD = 8;
const MAX_C_BYTES = 254;

export type DbfFieldMeta = { name: string; type: 'C' | 'N' | 'L'; size: number };

function lpad(str: string, len: number, ch: string): string {
  while (str.length < len) str = ch + str;
  return str;
}

function writeAsciiField(view: DataView, fieldLength: number, str: string, offset: number): number {
  const s = str.slice(0, fieldLength);
  for (let i = 0; i < fieldLength; i++) {
    const code = i < s.length ? s.charCodeAt(i) : 0x20;
    view.setUint8(offset + i, code < 256 ? code : 0x3f);
  }
  return offset + fieldLength;
}

function writeUtf8CString(view: DataView, byteLength: number, str: string, offset: number): number {
  const bytes = new TextEncoder().encode(str);
  let i = 0;
  for (; i < byteLength; i++) {
    view.setUint8(offset + i, i < bytes.length ? bytes[i] : 0x20);
  }
  return offset + byteLength;
}

/** Valid dBase III field name: start with letter, up to 8 chars A-Z 0-9 _ */
function assignDbfFieldNames(keys: string[]): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  keys.forEach((original, index) => {
    let base = original
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9_]/g, '_')
      .replace(/^[0-9]/, '_$&')
      .toUpperCase();
    if (!base || /^_+$/.test(base)) base = `F${index}`;
    base = base.slice(0, MAX_FIELD);
    let name = base;
    let n = 2;
    while (used.has(name)) {
      const suf = String(n++);
      name = (base.slice(0, MAX_FIELD - suf.length) + suf).slice(0, MAX_FIELD);
    }
    used.add(name);
    out.set(original, name);
  });
  return out;
}

function normalizeRows(
  rows: Array<Record<string, unknown>>,
  keyMap: Map<string, string>
): Array<Record<string, unknown>> {
  const keys = Array.from(keyMap.keys());
  return rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const k of keys) {
      const tgt = keyMap.get(k);
      if (tgt) o[tgt] = r[k];
    }
    return o;
  });
}

function inferMeta(data: Array<Record<string, unknown>>): DbfFieldMeta[] {
  if (data.length === 0) return [];
  const keySet = new Set<string>();
  for (const r of data) {
    for (const k of Object.keys(r)) keySet.add(k);
  }
  const keys = Array.from(keySet);
  const enc = new TextEncoder();

  return keys.map((name) => {
    const vals = data.map((r) => r[name]);
    const allBool =
      vals.some((v) => typeof v === 'boolean') &&
      vals.every((v) => v === null || v === undefined || typeof v === 'boolean');
    if (allBool) {
      return { name, type: 'L', size: 1 };
    }
    const allNum =
      vals.some((v) => typeof v === 'number' && Number.isFinite(v)) &&
      vals.every((v) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v)));
    if (allNum) {
      return { name, type: 'N', size: 18 };
    }
    let maxB = 1;
    for (const v of vals) {
      const s = v === null || v === undefined ? '' : String(v);
      const b = enc.encode(s).length;
      if (b > maxB) maxB = b;
    }
    return { name, type: 'C', size: Math.min(MAX_C_BYTES, Math.max(1, maxB)) };
  });
}

function bytesPerRecord(fieldMeta: DbfFieldMeta[]): number {
  return fieldMeta.reduce((m, f) => m + f.size, 1);
}

/**
 * Build DBF III buffer. Rows must use ASCII field names (≤8 chars) as keys.
 */
export function buildDbfUtf8Buffer(data: Array<Record<string, unknown>>): ArrayBuffer {
  const field_meta = inferMeta(data);
  const fieldDescLength = 32 * field_meta.length + 1;
  const bpr = bytesPerRecord(field_meta);
  const headerLength = fieldDescLength + 32;
  const buf = new ArrayBuffer(headerLength + bpr * data.length + 1);
  const view = new DataView(buf);
  const now = new Date();

  view.setUint8(0, 0x03);
  view.setUint8(1, now.getFullYear() - 1900);
  view.setUint8(2, now.getMonth());
  view.setUint8(3, now.getDate());
  view.setUint32(4, data.length, true);
  view.setUint16(8, headerLength, true);
  view.setUint16(10, bpr, true);
  view.setInt8(32 + fieldDescLength - 1, 0x0d);

  field_meta.forEach((f, i) => {
    const base = 32 + i * 32;
    writeAsciiField(view, MAX_FIELD, f.name, base);
    view.setInt8(base + 11, f.type.charCodeAt(0));
    view.setInt8(base + 16, f.size);
    if (f.type === 'N') view.setInt8(base + 17, 3);
  });

  let offset = headerLength;
  data.forEach((row) => {
    view.setUint8(offset, 32);
    offset++;
    for (const f of field_meta) {
      const val = row[f.name];
      const raw = val === null || val === undefined ? '' : val;
      switch (f.type) {
        case 'L':
          view.setUint8(offset, raw ? 84 : 70);
          offset++;
          break;
        case 'N':
          offset = writeAsciiField(
            view,
            f.size,
            lpad(String(raw), f.size, ' ').slice(0, f.size),
            offset
          );
          break;
        case 'C':
          offset = writeUtf8CString(view, f.size, String(raw), offset);
          break;
        default:
          throw new Error(`Unknown DBF type ${f.type}`);
      }
    }
  });

  view.setUint8(offset, 0x1a);
  return buf;
}

/** Replace `.dbf` inside a shapefile ZIP with UTF-8-safe tables + `.cpg` (does not alter `.shp` / `.shx`). */
export async function patchShapefileZipUtf8Dbf(
  zipBlob: Blob,
  folderName: string,
  baseName: string,
  rows: Array<Record<string, unknown>>
): Promise<Blob> {
  if (rows.length === 0) return zipBlob;
  const zip = await JSZip.loadAsync(await zipBlob.arrayBuffer());
  const folder = zip.folder(folderName);
  if (!folder) return zipBlob;
  const { buffer } = buildDbfUtf8FromPropertyRows(rows);
  folder.file(`${baseName}.dbf`, buffer);
  folder.file(`${baseName}.cpg`, 'UTF-8');
  return zip.generateAsync({ type: 'blob', compression: 'STORE' });
}

/**
 * Prepare rows for UTF-8 DBF: map original attribute keys (any Unicode) to dBase-safe 8-char names.
 */
export function buildDbfUtf8FromPropertyRows(
  rows: Array<Record<string, unknown>>
): { buffer: ArrayBuffer; fieldNamesOriginalToDbf: Array<[string, string]> } {
  const unionKeys = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) unionKeys.add(k);
  }
  const keys = Array.from(unionKeys);
  const keyMap = assignDbfFieldNames(keys);
  const normalized = normalizeRows(rows, keyMap);
  const buffer = buildDbfUtf8Buffer(normalized);
  const fieldNamesOriginalToDbf = keys.map((k) => [k, keyMap.get(k) || k] as [string, string]);
  return { buffer, fieldNamesOriginalToDbf };
}
