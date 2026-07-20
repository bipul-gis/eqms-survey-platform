import type { EnumeratorInfo, Question, UserProfile } from '../types';
import { enumeratorResolvedDisplayName } from './userDisplayName';

/**
 * Standard identity rows shown at the top of the enumerator-info table.
 * Prefixed with stable `sys_` ids so they survive across sessions and stay
 * distinct from admin-authored field ids.
 */
export const ENUMERATOR_IDENTITY_SPECS: Array<{
  key: string;
  type: Question['type'];
  question: string;
  required: boolean;
}> = [
  { key: 'enumerator_name', type: 'text', question: 'Enumerator Name', required: true },
  { key: 'enumerator_id', type: 'text', question: 'Enumerator ID', required: true },
  { key: 'enumerator_phone', type: 'phone', question: 'Phone', required: false },
  { key: 'enumerator_email', type: 'email', question: 'Email', required: false }
];

const ENUMERATOR_FIELD_MARKERS = [
  'enumerator',
  'enum_',
  'surveyor',
  'interviewer',
  'investigator',
  'staff',
  'data collector',
  'data_collector',
  'your '
];

const hasEnumeratorMarker = (f: Question): boolean => {
  const hay = `${f.key || ''} ${f.question || ''}`.toLowerCase();
  return ENUMERATOR_FIELD_MARKERS.some((m) => hay.includes(m));
};

export const looksLikeEnumeratorNameField = (f: Question): boolean => {
  const hay = `${f.key || ''} ${f.question || ''}`.toLowerCase();
  if (!(/\bname\b/.test(hay) || /\bনাম/.test(hay))) return false;
  return hasEnumeratorMarker(f) || f.key === 'enumerator_name';
};

export const looksLikeEnumeratorPhoneField = (f: Question): boolean => {
  const hay = `${f.key || ''} ${f.question || ''}`.toLowerCase();
  const phoneHit =
    /\b(phone|mobile|contact|cell)\b/.test(hay) || /\bমোবাইল|\bফোন/.test(hay);
  if (!phoneHit) return false;
  return hasEnumeratorMarker(f) || f.key === 'enumerator_phone';
};

export const looksLikeEnumeratorEmailField = (f: Question): boolean => {
  const hay = `${f.key || ''} ${f.question || ''}`.toLowerCase();
  const emailHit = /\bemail\b|\be-mail\b|\bমেইল/.test(hay) || f.type === 'email';
  if (!emailHit) return false;
  // Email-type fields inside enumerator-info are always enumerator email;
  // otherwise require an enumerator marker (or the standard key).
  if (f.type === 'email' || f.key === 'enumerator_email') return true;
  return hasEnumeratorMarker(f);
};

/** Enumerator ID / employee code / uid field. */
export const looksLikeEnumeratorIdField = (f: Question): boolean => {
  const key = (f.key || '').toLowerCase();
  if (
    key === 'enumerator_id' ||
    key === 'enum_id' ||
    key === 'surveyor_id' ||
    key === 'employee_id' ||
    key === 'staff_id'
  ) {
    return true;
  }
  const hay = `${key} ${f.question || ''}`.toLowerCase();
  const idHit =
    /\b(enumerator\s*id|enum\s*id|surveyor\s*id|employee\s*id|staff\s*id|user\s*id)\b/.test(
      hay
    ) || /\bid\b/.test(hay);
  if (!idHit) return false;
  // Bare "ID" alone is too ambiguous; require enumerator marker unless key matched above.
  return hasEnumeratorMarker(f) || /\b(enumerator|surveyor|employee|staff|user)\s*id\b/.test(hay);
};

export const isEnumeratorIdentityField = (f: Question): boolean =>
  looksLikeEnumeratorNameField(f) ||
  looksLikeEnumeratorIdField(f) ||
  looksLikeEnumeratorPhoneField(f) ||
  looksLikeEnumeratorEmailField(f);

const pad2 = (n: number) => String(n).padStart(2, '0');
const formatLocalDate = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const formatLocalTime = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const formatLocalDateTime = (d: Date) => `${formatLocalDate(d)}T${formatLocalTime(d)}`;

export function profileValueForIdentityField(
  f: Question,
  profile: UserProfile | null,
  authUser?: { uid?: string; email?: string | null; displayName?: string | null } | null
): string | undefined {
  if (!profile && !authUser) return undefined;
  if (looksLikeEnumeratorEmailField(f)) {
    return (profile?.email || authUser?.email || '').trim() || undefined;
  }
  if (looksLikeEnumeratorPhoneField(f)) {
    return (profile?.mobileNumber || '').trim() || undefined;
  }
  if (looksLikeEnumeratorIdField(f)) {
    return (profile?.uid || authUser?.uid || '').trim() || undefined;
  }
  if (looksLikeEnumeratorNameField(f)) {
    return (
      enumeratorResolvedDisplayName(profile, authUser) ||
      (profile?.displayName || authUser?.displayName || '').trim() ||
      undefined
    );
  }
  return undefined;
}

/**
 * Ensure name / id / phone / email rows exist at the top of the enumerator-info
 * table. Existing matching fields are kept (admin wording preserved); only
 * missing identity rows are injected with stable `sys_*` ids.
 */
export function ensureEnumeratorIdentityFields(
  info: EnumeratorInfo | undefined | null
): EnumeratorInfo | undefined {
  if (!info || !info.enabled) return info ?? undefined;
  const fields = [...(info.fields || [])];
  const missing: Question[] = [];

  for (const spec of ENUMERATOR_IDENTITY_SPECS) {
    const exists = fields.some((f) => {
      if ((f.key || '').toLowerCase() === spec.key) return true;
      if (spec.key === 'enumerator_name') return looksLikeEnumeratorNameField(f);
      if (spec.key === 'enumerator_id') return looksLikeEnumeratorIdField(f);
      if (spec.key === 'enumerator_phone') return looksLikeEnumeratorPhoneField(f);
      if (spec.key === 'enumerator_email') return looksLikeEnumeratorEmailField(f);
      return false;
    });
    if (!exists) {
      missing.push({
        id: `sys_${spec.key}`,
        key: spec.key,
        type: spec.type,
        question: spec.question,
        required: spec.required
      });
    }
  }

  if (missing.length === 0) return info;
  return { ...info, fields: [...missing, ...fields] };
}

/** Field ids that must be read-only for enumerators (profile-backed). */
export function collectEnumeratorIdentityFieldIds(
  fields: Question[] | undefined
): Set<string> {
  const ids = new Set<string>();
  for (const f of fields || []) {
    if (isEnumeratorIdentityField(f)) ids.add(f.id);
  }
  return ids;
}

/**
 * Build initial enumerator-info answers: identity from profile, date/time = now.
 * Admin `defaultValue` wins for non-identity fields only — identity always
 * comes from the signed-in account when available.
 */
export function buildInitialEnumeratorInfo(
  fields: Question[] | undefined,
  profile: UserProfile | null,
  authUser?: { uid?: string; email?: string | null; displayName?: string | null } | null
): Record<string, unknown> {
  if (!fields || fields.length === 0) return {};
  const now = new Date();
  const out: Record<string, unknown> = {};

  for (const f of fields) {
    if (isEnumeratorIdentityField(f)) {
      const fromProfile = profileValueForIdentityField(f, profile, authUser);
      if (fromProfile !== undefined) out[f.id] = fromProfile;
      else if (f.defaultValue !== undefined && f.defaultValue !== null && f.defaultValue !== '') {
        out[f.id] = f.defaultValue;
      }
      continue;
    }

    if (f.defaultValue !== undefined && f.defaultValue !== null && f.defaultValue !== '') {
      out[f.id] = f.defaultValue;
      continue;
    }

    if (f.type === 'date') {
      out[f.id] = formatLocalDate(now);
      continue;
    }
    if (f.type === 'time') {
      out[f.id] = formatLocalTime(now);
      continue;
    }
    if (f.type === 'datetime') {
      out[f.id] = formatLocalDateTime(now);
    }
  }
  return out;
}

/** Patch identity answers from the live profile (always overwrite). */
export function syncEnumeratorIdentityAnswers(
  fields: Question[] | undefined,
  profile: UserProfile | null,
  authUser?: { uid?: string; email?: string | null; displayName?: string | null } | null
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const f of fields || []) {
    if (!isEnumeratorIdentityField(f)) continue;
    const v = profileValueForIdentityField(f, profile, authUser);
    if (v !== undefined) patch[f.id] = v;
  }
  return patch;
}
