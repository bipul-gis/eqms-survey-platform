import type { Question, QuestionType, UserProfile } from '../types';
import { enumeratorResolvedDisplayName } from './userDisplayName';

/** How a preset fills itself on the enumerator form. */
export type EnumeratorAutoSource = 'account' | 'today';

/**
 * Presets admins pick from when adding Enumerator Information fields.
 * Only fields the admin selects appear on the survey — nothing is injected
 * at runtime.
 */
export interface EnumeratorAutoFieldPreset {
  key: string;
  type: QuestionType;
  /** Default English label (admin can rename after adding). */
  question: string;
  required: boolean;
  autoSource: EnumeratorAutoSource;
  /** Short hint shown in the builder picker. */
  hint: string;
}

export const ENUMERATOR_AUTO_FIELD_PRESETS: EnumeratorAutoFieldPreset[] = [
  {
    key: 'enumerator_name',
    type: 'text',
    question: 'Enumerator Name',
    required: true,
    autoSource: 'account',
    hint: 'Auto from account · not editable'
  },
  {
    key: 'enumerator_id',
    type: 'text',
    question: 'Enumerator ID',
    required: true,
    autoSource: 'account',
    hint: 'Auto from account · not editable'
  },
  {
    key: 'enumerator_phone',
    type: 'phone',
    question: 'Phone',
    required: false,
    autoSource: 'account',
    hint: 'Auto from account · not editable'
  },
  {
    key: 'enumerator_email',
    type: 'email',
    question: 'Email',
    required: false,
    autoSource: 'account',
    hint: 'Auto from account · not editable'
  },
  {
    key: 'survey_date',
    type: 'date',
    question: 'Date of Survey',
    required: true,
    autoSource: 'today',
    hint: 'Auto-filled with today’s date'
  }
];

/** @deprecated Use ENUMERATOR_AUTO_FIELD_PRESETS — kept for older imports. */
export const ENUMERATOR_IDENTITY_SPECS = ENUMERATOR_AUTO_FIELD_PRESETS.filter(
  (p) => p.autoSource === 'account'
).map((p) => ({
  key: p.key,
  type: p.type,
  question: p.question,
  required: p.required
}));

const ENUMERATOR_FIELD_MARKERS = [
  'enumerator',
  'enum_',
  'surveyor',
  'interviewer',
  'investigator',
  'staff',
  'data collector',
  'data_collector',
  'your ',
  'জরিপকারী'
];

const hasEnumeratorMarker = (f: Question): boolean => {
  const hay = `${f.key || ''} ${f.question || ''}`.toLowerCase();
  return ENUMERATOR_FIELD_MARKERS.some((m) => hay.includes(m.toLowerCase()));
};

const keyOf = (f: Question) => (f.key || '').toLowerCase().trim();

export const looksLikeEnumeratorNameField = (f: Question): boolean => {
  const key = keyOf(f);
  if (
    key === 'enumerator_name' ||
    key === 'enum_name' ||
    key === 'surveyor_name' ||
    key === 'interviewer_name'
  ) {
    return true;
  }
  const hay = `${key} ${f.question || ''}`.toLowerCase();
  const nameHit =
    key.includes('name') ||
    /\bname\b/.test(hay) ||
    (f.question || '').includes('নাম');
  if (!nameHit) return false;
  return hasEnumeratorMarker(f);
};

export const looksLikeEnumeratorPhoneField = (f: Question): boolean => {
  const key = keyOf(f);
  if (key === 'enumerator_phone' || key === 'enum_phone' || key === 'surveyor_phone') {
    return true;
  }
  if (f.type === 'phone' && hasEnumeratorMarker(f)) return true;
  const hay = `${key} ${f.question || ''}`.toLowerCase();
  const phoneHit =
    /\b(phone|mobile|contact|cell)\b/.test(hay) ||
    (f.question || '').includes('মোবাইল') ||
    (f.question || '').includes('ফোন');
  if (!phoneHit) return false;
  return hasEnumeratorMarker(f);
};

export const looksLikeEnumeratorEmailField = (f: Question): boolean => {
  const key = keyOf(f);
  if (key === 'enumerator_email' || key === 'enum_email' || key === 'surveyor_email') {
    return true;
  }
  // Email-type rows in this section are enumerator email by convention.
  if (f.type === 'email') return true;
  const hay = `${key} ${f.question || ''}`.toLowerCase();
  const emailHit = /\bemail\b|\be-mail\b/.test(hay) || (f.question || '').includes('মেইল');
  if (!emailHit) return false;
  return hasEnumeratorMarker(f);
};

/** Enumerator ID / employee code / uid field. */
export const looksLikeEnumeratorIdField = (f: Question): boolean => {
  const key = keyOf(f);
  if (
    key === 'enumerator_id' ||
    key === 'enum_id' ||
    key === 'surveyor_id' ||
    key === 'employee_id' ||
    key === 'staff_id'
  ) {
    return true;
  }
  const qText = f.question || '';
  const hay = `${key} ${qText}`.toLowerCase();
  const idHit =
    /\b(enumerator\s*id|enum\s*id|surveyor\s*id|employee\s*id|staff\s*id|user\s*id)\b/.test(
      hay
    ) ||
    qText.includes('আইডি') ||
    qText.includes('আই ডি');
  if (!idHit) return false;
  return hasEnumeratorMarker(f);
};

export const isEnumeratorIdentityField = (f: Question): boolean =>
  looksLikeEnumeratorNameField(f) ||
  looksLikeEnumeratorIdField(f) ||
  looksLikeEnumeratorPhoneField(f) ||
  looksLikeEnumeratorEmailField(f);

export function presetKeyAlreadyUsed(
  fields: Question[] | undefined,
  presetKey: string
): boolean {
  const want = presetKey.toLowerCase();
  return (fields || []).some((f) => {
    if (keyOf(f) === want) return true;
    if (want === 'enumerator_name') return looksLikeEnumeratorNameField(f);
    if (want === 'enumerator_id') return looksLikeEnumeratorIdField(f);
    if (want === 'enumerator_phone') return looksLikeEnumeratorPhoneField(f);
    if (want === 'enumerator_email') return looksLikeEnumeratorEmailField(f);
    if (want === 'survey_date') {
      return keyOf(f) === 'survey_date';
    }
    return false;
  });
}

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
 * Only fields present on the questionnaire are filled — admins choose which.
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
