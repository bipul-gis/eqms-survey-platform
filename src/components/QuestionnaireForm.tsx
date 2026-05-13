/**
 * QuestionnaireForm — the live submission form used by enumerators.
 *
 * Mirrors the admin Preview layout (description → enumerator info → consent
 * gate → questions → submission GPS) and writes a real `QuestionnaireResponse`
 * to Firestore. Supports two visual variants:
 *
 *  - `fullscreen` — full-viewport centered column, used by enumerators on
 *    phones/tablets via `EnumeratorQuestionnaireList`.
 *  - `drawer` — fixed-width right-side panel, used by the admin geospatial
 *    flow when an admin opens a questionnaire over the map.
 *
 * All renderers (description blocks, enumerator info table, consent gate, GPS
 * capture widget, per-question controls) come from the shared
 * `QuestionnaireRuntime` module so this component stays focused on submission
 * state, validation, and Firestore I/O.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from './AuthProvider';
import {
  Questionnaire,
  QuestionnaireResponse,
  Question,
  GpsCaptureSettings,
  SubmissionGpsCapture,
  UserProfile
} from '../types';
import {
  AlertCircle,
  FileText,
  MapPin,
  Save,
  Send,
  X,
  Lock
} from 'lucide-react';
import {
  addDoc,
  collection,
  doc,
  serverTimestamp,
  updateDoc
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  ConsentGateForm,
  DescriptionRenderer,
  EnumeratorInfoTable,
  RuntimeQuestion,
  SubmissionGpsCaptureWidget,
  computeAppliedDefaultRules,
  evaluateLogic,
  ruleValueMatchesCurrent
} from './QuestionnaireRuntime';

interface QuestionnaireFormProps {
  questionnaire: Questionnaire;
  onClose: () => void;
  onSubmit?: (response: QuestionnaireResponse) => void;
  initialLocation?: { lat: number; lng: number; ward?: string };
  /**
   * `drawer` (default) — fixed-width right-side drawer (admin map view).
   * `fullscreen` — fills the viewport with a centered scrollable column,
   * appropriate for enumerators completing the form on phones/tablets.
   */
  variant?: 'drawer' | 'fullscreen';
  /**
   * Optional existing response document to resume / edit. When provided the
   * form is pre-filled with its answers, enumerator info, consent and GPS;
   * Save Draft / Submit will `updateDoc` the same doc instead of creating
   * a new one (so a single draft can be edited many times before submit).
   */
  existingResponse?: QuestionnaireResponse;
  /**
   * Render the form as a read-only viewer (used by the enumerator's "My
   * Responses" panel to inspect already-submitted entries). Disables every
   * input and hides Save Draft / Submit buttons. Has no effect on data.
   */
  readOnly?: boolean;
}

interface CapturedGps {
  lat: number;
  lng: number;
  accuracy: number;
  durationSeconds: number;
}

/** Remove `undefined` values — Firestore's `addDoc` rejects them. */
const stripUndefined = <T extends Record<string, any>>(obj: T): T => {
  const out = {} as Record<string, any>;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
};

// ---- Auto-capture helpers (used to pre-fill date/time enumerator-info fields)

const pad2 = (n: number) => String(n).padStart(2, '0');
const formatLocalDate = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const formatLocalTime = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const formatLocalDateTime = (d: Date) => `${formatLocalDate(d)}T${formatLocalTime(d)}`;

/**
 * Words that unambiguously identify the *enumerator* (vs. the respondent,
 * slum, household, etc.). The auto-capture for name/email/phone only fires
 * when one of these qualifiers appears in the field key or question text —
 * otherwise we'd wrongly fill things like "Slum Name" or "Respondent Email"
 * with the enumerator's profile values.
 */
const ENUMERATOR_FIELD_MARKERS = [
  'enumerator',
  'enum_',
  'surveyor',
  'interviewer',
  'investigator',
  'staff',
  'data collector',
  'data_collector',
  'your '  // "Your Name", "Your Email", "Your Phone"
];

const hasEnumeratorMarker = (f: Question): boolean => {
  const hay = `${f.key || ''} ${f.question || ''}`.toLowerCase();
  return ENUMERATOR_FIELD_MARKERS.some((m) => hay.includes(m));
};

/** True if the field is explicitly the *enumerator's* name. */
const looksLikeEnumeratorNameField = (f: Question): boolean => {
  const hay = `${f.key || ''} ${f.question || ''}`.toLowerCase();
  if (!(/\bname\b/.test(hay) || /\bনাম/.test(hay))) return false;
  return hasEnumeratorMarker(f);
};

/** True if the field is explicitly the *enumerator's* phone / mobile. */
const looksLikeEnumeratorPhoneField = (f: Question): boolean => {
  const hay = `${f.key || ''} ${f.question || ''}`.toLowerCase();
  const phoneHit =
    /\b(phone|mobile|contact|cell)\b/.test(hay) || /\bমোবাইল|\bফোন/.test(hay);
  if (!phoneHit) return false;
  return hasEnumeratorMarker(f);
};

/** True if the field is explicitly the *enumerator's* email. */
const looksLikeEnumeratorEmailField = (f: Question): boolean => {
  const hay = `${f.key || ''} ${f.question || ''}`.toLowerCase();
  const emailHit = /\bemail\b|\be-mail\b|\bমেইল/.test(hay);
  if (!emailHit) return false;
  return hasEnumeratorMarker(f);
};

/**
 * Build the initial answers map for the enumerator-info section.
 *
 * Pre-fills two kinds of fields so an enumerator doesn't have to type the
 * same data on every survey:
 *
 *   1. **Date / time fields** — current local date / time at the moment
 *      the form is opened ("Date of Survey", "Survey Start Time").
 *   2. **Identity fields** — when the question or key clearly indicates the
 *      *enumerator's own* name / email / phone (the whole section is
 *      contextually about the enumerator), the corresponding value from
 *      the signed-in `UserProfile` is filled in.
 *
 * Explicit field-level `defaultValue` (set by the admin in the builder)
 * always wins over the auto-capture.
 */
const buildInitialEnumeratorInfo = (
  fields: Question[] | undefined,
  profile: UserProfile | null
): Record<string, any> => {
  if (!fields || fields.length === 0) return {};
  const now = new Date();
  const out: Record<string, any> = {};
  for (const f of fields) {
    if (f.defaultValue !== undefined && f.defaultValue !== null && f.defaultValue !== '') {
      out[f.id] = f.defaultValue;
      continue;
    }

    // Date / time auto-capture (independent of profile).
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
      continue;
    }

    if (!profile) continue;

    // Identity auto-capture is strictly *enumerator-scoped*. A field is only
    // filled when its key / question text contains an explicit enumerator
    // marker (e.g. "Enumerator Name", "Surveyor Phone"). This avoids
    // hijacking unrelated "Name"/"Email"/"Phone" fields that happen to live
    // in the section (like "Slum Name" or a respondent contact).
    const isTexty =
      f.type === 'text' || f.type === 'longtext' || f.type === 'email' || f.type === 'phone';
    if (!isTexty) continue;

    if (looksLikeEnumeratorEmailField(f)) {
      if (profile.email) out[f.id] = profile.email;
      continue;
    }
    if (looksLikeEnumeratorPhoneField(f)) {
      if (profile.mobileNumber) out[f.id] = profile.mobileNumber;
      continue;
    }
    if (looksLikeEnumeratorNameField(f)) {
      if (profile.displayName) out[f.id] = profile.displayName;
    }
  }
  return out;
};

/**
 * Reasonable RFC-5322-lite regex — accepts the formats users actually
 * type without dragging in a 200-line full RFC parser. Catches the most
 * common typos (missing `@`, missing TLD, illegal characters) which is
 * the whole point of validating in-form.
 */
const EMAIL_REGEX = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

/** Strip everything that isn't a digit so we can count phone digits regardless of formatting. */
const phoneDigitCount = (value: string): number => value.replace(/\D/g, '').length;

/**
 * Validate a single question against the current answer. Section dividers
 * never require a value; everything else honours `required` + numeric/text
 * validation rules.
 */
const validateQuestion = (q: Question, value: unknown): string | null => {
  if (q.type === 'section') return null;
  const isEmpty =
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0);
  if (q.required && isEmpty) return 'This field is required';

  if (isEmpty) return null;

  // Type-driven format validation — runs even when `q.validation` isn't
  // configured. Email and phone inputs deserve sane built-in checks so
  // admins don't have to remember to author a regex for every survey.
  if (q.type === 'email' && typeof value === 'string') {
    if (!EMAIL_REGEX.test(value.trim())) {
      return q.validation?.errorMessage || 'Enter a valid email address (e.g. name@example.com)';
    }
  }

  if (q.type === 'phone' && typeof value === 'string') {
    const digits = phoneDigitCount(value);
    if (digits === 0) {
      return q.validation?.errorMessage || 'Enter a valid phone number';
    }
    const v = q.validation;
    if (v) {
      if (v.digits !== undefined && digits !== v.digits) {
        return v.errorMessage || `Phone number must have exactly ${v.digits} digits (you entered ${digits})`;
      }
      if (v.digits === undefined) {
        if (v.min !== undefined && digits < v.min) {
          return v.errorMessage || `Phone number must have at least ${v.min} digits (you entered ${digits})`;
        }
        if (v.max !== undefined && digits > v.max) {
          return v.errorMessage || `Phone number must have at most ${v.max} digits (you entered ${digits})`;
        }
      }
    }
  }

  if (q.validation) {
    if (q.type === 'number') {
      const num = Number(value);
      if (q.validation.min !== undefined && num < q.validation.min)
        return q.validation.errorMessage || `Value must be at least ${q.validation.min}`;
      if (q.validation.max !== undefined && num > q.validation.max)
        return q.validation.errorMessage || `Value must be at most ${q.validation.max}`;
    }
    if (q.validation.pattern && typeof value === 'string') {
      try {
        if (!new RegExp(q.validation.pattern).test(value)) {
          return q.validation.errorMessage || 'Invalid format';
        }
      } catch {
        /* invalid regex in builder — ignore so we don't block submission */
      }
    }
  }
  return null;
};

const friendlyError = (e: unknown): string => {
  const raw = e instanceof Error ? e.message : String(e);
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.error) return String(parsed.error);
  } catch {
    /* not JSON */
  }
  return raw || 'Something went wrong.';
};

export const QuestionnaireForm: React.FC<QuestionnaireFormProps> = ({
  questionnaire,
  onClose,
  onSubmit,
  initialLocation,
  variant = 'drawer',
  existingResponse,
  readOnly = false
}) => {
  const { user, userProfile } = useAuth();
  const isFullscreen = variant === 'fullscreen';
  const isResuming = !!existingResponse;
  const existingId = existingResponse?.id;

  const [responses, setResponses] = useState<Record<string, any>>(
    () => existingResponse?.responses || {}
  );
  // Lazy init so the "now" snapshot is taken when the form first mounts,
  // not on every re-render. Date / time fields are pre-filled with the
  // current local date/time; name / email / phone fields are pre-filled
  // from the signed-in enumerator's profile when their question or key
  // makes the intent clear. Admin-supplied `defaultValue` always wins.
  // When resuming a draft we restore the previously captured values
  // verbatim — the original survey-start time stays accurate.
  const [enumeratorInfo, setEnumeratorInfo] = useState<Record<string, any>>(() =>
    existingResponse?.enumeratorInfo
      ? { ...existingResponse.enumeratorInfo }
      : buildInitialEnumeratorInfo(questionnaire.enumeratorInfo?.fields, userProfile)
  );
  const [consentGranted, setConsentGranted] = useState(
    () => !!existingResponse?.consentGranted
  );
  const [consentGrantedAt, setConsentGrantedAt] = useState<Date | null>(() => {
    const raw = existingResponse?.consentGrantedAt;
    if (!raw) return null;
    const d = new Date(raw as string);
    return Number.isFinite(d.getTime()) ? d : null;
  });
  const [submissionGps, setSubmissionGps] = useState<CapturedGps | null>(() => {
    const s = existingResponse?.submissionLocation;
    if (!s) return null;
    return {
      lat: s.lat,
      lng: s.lng,
      accuracy: s.accuracy,
      durationSeconds: s.durationSeconds ?? 0
    };
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [enumeratorErrors, setEnumeratorErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [currentLocation, setCurrentLocation] = useState(
    existingResponse?.location || initialLocation
  );

  useEffect(() => {
    if (initialLocation && !existingResponse?.location) setCurrentLocation(initialLocation);
  }, [initialLocation, existingResponse?.location]);

  // Questionnaire-level config — preserve old default behaviour when missing.
  const descriptionBlocks = questionnaire.descriptionBlocks || [];
  const enumeratorInfoConfig = questionnaire.enumeratorInfo;
  const consentGate = questionnaire.consentGate;
  const submissionGpsConfig: SubmissionGpsCapture | undefined = questionnaire.submissionGps;
  const settings = questionnaire.settings || {};

  // Gate: questions only revealed once consent ticked (when consent is enabled).
  const questionsUnlocked = !consentGate?.enabled || consentGranted;

  // Visible questions respect display logic AND the consent gate.
  const visibleQuestions = useMemo(
    () => (questionnaire.questions || []).filter((q) => evaluateLogic(q.logic, responses)),
    [questionnaire.questions, responses]
  );

  // Auto-fill / lock — evaluate every question's `defaultValueRules`
  // against the current answers and patch in changes. Scoped to
  // `visibleQuestions` so a hidden question never silently mutates its
  // own answer (would be confusing to admins reviewing CSV exports).
  // The effect is guarded against unnecessary writes via
  // `ruleValueMatchesCurrent`, which prevents a rule from fighting the
  // enumerator's own typing or causing an infinite render loop.
  const appliedDefaultRules = useMemo(
    () => computeAppliedDefaultRules(visibleQuestions, responses),
    [visibleQuestions, responses]
  );

  // Lock-mode rules disable the corresponding input so enumerators can't
  // edit a value the admin has explicitly tied to another answer. Held
  // as a Set so the JSX render path can do an O(1) lookup per question.
  const lockedQuestionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of appliedDefaultRules) {
      if (r.mode === 'lock') ids.add(r.questionId);
    }
    return ids;
  }, [appliedDefaultRules]);

  useEffect(() => {
    if (appliedDefaultRules.length === 0 || readOnly) return;
    const patch: Record<string, unknown> = {};
    for (const r of appliedDefaultRules) {
      const current = responses[r.questionId];
      if (r.mode === 'lock') {
        // Lock keeps the answer mirrored to the rule value as long as
        // the trigger condition holds.
        if (!ruleValueMatchesCurrent(current, r.value)) {
          patch[r.questionId] = r.value;
        }
      } else {
        // fillIfEmpty — only set when the enumerator hasn't entered
        // anything yet, so we never overwrite their typing.
        if (
          (current === undefined ||
            current === null ||
            current === '' ||
            (Array.isArray(current) && current.length === 0)) &&
          !ruleValueMatchesCurrent(current, r.value)
        ) {
          patch[r.questionId] = r.value;
        }
      }
    }
    if (Object.keys(patch).length === 0) return;
    setResponses((prev) => ({ ...prev, ...patch }));
    // Clear any stale validation errors for questions we just patched —
    // a "Required" warning would be misleading right after the value
    // appeared automatically.
    setErrors((prev) => {
      let dirty = false;
      const next = { ...prev };
      for (const key of Object.keys(patch)) {
        if (next[key]) {
          delete next[key];
          dirty = true;
        }
      }
      return dirty ? next : prev;
    });
  }, [appliedDefaultRules, responses, readOnly]);

  // Progress %
  const { progress } = useMemo(() => {
    const required = visibleQuestions.filter((q) => q.required && q.type !== 'section');
    const answered = required.filter((q) => {
      const v = responses[q.id];
      return v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);
    }).length;
    const pct = !questionsUnlocked || required.length === 0
      ? 0
      : Math.round((answered / required.length) * 100);
    return { progress: pct };
  }, [visibleQuestions, responses, questionsUnlocked]);

  // ---- input handlers ----------------------------------------------------

  const handleAnswer = (questionId: string, value: any) => {
    setResponses((prev) => ({ ...prev, [questionId]: value }));
    setErrors((prev) => {
      if (!prev[questionId]) return prev;
      const next = { ...prev };
      delete next[questionId];
      return next;
    });
  };

  const handleEnumeratorChange = (fieldId: string, value: unknown) => {
    setEnumeratorInfo((prev) => ({ ...prev, [fieldId]: value }));
    setEnumeratorErrors((prev) => {
      if (!prev[fieldId]) return prev;
      const next = { ...prev };
      delete next[fieldId];
      return next;
    });
  };

  const handleConsentChange = (granted: boolean) => {
    setConsentGranted(granted);
    if (granted && !consentGrantedAt) setConsentGrantedAt(new Date());
    if (!granted) setConsentGrantedAt(null);
  };

  // ---- validation --------------------------------------------------------

  const validateAll = (): boolean => {
    const newQ: Record<string, string> = {};
    const newE: Record<string, string> = {};

    for (const f of enumeratorInfoConfig?.fields || []) {
      const err = validateQuestion(f, enumeratorInfo[f.id]);
      if (err) newE[f.id] = err;
    }

    if (questionsUnlocked) {
      for (const q of visibleQuestions) {
        const err = validateQuestion(q, responses[q.id]);
        if (err) newQ[q.id] = err;
      }
    }

    setErrors(newQ);
    setEnumeratorErrors(newE);

    const consentOk = !consentGate?.enabled || consentGranted;
    const gpsOk =
      !submissionGpsConfig?.enabled || !submissionGpsConfig.required || submissionGps !== null;

    return Object.keys(newQ).length === 0 && Object.keys(newE).length === 0 && consentOk && gpsOk;
  };

  // ---- save / submit -----------------------------------------------------

  /**
   * Build the Firestore payload. Omits `undefined` keys so `addDoc()` accepts
   * it (Firestore rejects undefined). `respondentId === auth.uid` is required
   * by `firestore.rules`.
   */
  const buildResponseData = (
    status: 'draft' | 'submitted'
  ): Omit<QuestionnaireResponse, 'id'> => {
    const base: Record<string, any> = {
      questionnaireId: questionnaire.id,
      respondentId: user!.uid,
      responses,
      status
    };
    if (userProfile?.displayName) base.respondentName = userProfile.displayName;
    if (userProfile?.email) base.respondentEmail = userProfile.email;
    if (currentLocation) base.location = stripUndefined(currentLocation);
    if (enumeratorInfoConfig?.enabled && Object.keys(enumeratorInfo).length > 0)
      base.enumeratorInfo = enumeratorInfo;
    if (consentGate?.enabled) {
      base.consentGranted = consentGranted;
      if (consentGrantedAt) base.consentGrantedAt = consentGrantedAt.toISOString();
    }
    if (submissionGpsConfig?.enabled && submissionGps) {
      base.submissionLocation = stripUndefined({
        lat: submissionGps.lat,
        lng: submissionGps.lng,
        accuracy: submissionGps.accuracy,
        durationSeconds: submissionGps.durationSeconds,
        capturedAt: new Date().toISOString()
      });
    }
    if (status === 'submitted') base.submittedAt = serverTimestamp();
    // Stamp every write so the enumerator list can show "saved 5 min ago"
    // for drafts and admin tooling has a reliable last-touched timestamp.
    base.updatedAt = serverTimestamp();
    return stripUndefined(base) as Omit<QuestionnaireResponse, 'id'>;
  };

  const handleSaveDraft = async () => {
    if (!user || !userProfile) {
      setSubmitError('You must be signed in to save a draft.');
      return;
    }
    setSubmitError(null);
    setLoading(true);
    try {
      const responseData = buildResponseData('draft');
      if (existingId) {
        await updateDoc(doc(db, 'questionnaireResponses', existingId), responseData as any);
      } else {
        await addDoc(collection(db, 'questionnaireResponses'), responseData);
      }
      alert('Draft saved successfully!');
    } catch (error) {
      try {
        handleFirestoreError(
          error,
          existingId ? OperationType.UPDATE : OperationType.CREATE,
          'questionnaireResponses'
        );
      } catch (logged) {
        setSubmitError(friendlyError(logged));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async () => {
    if (!user || !userProfile) {
      setSubmitError('You must be signed in to submit.');
      return;
    }
    if (!validateAll()) {
      const missing: string[] = [];
      if (consentGate?.enabled && !consentGranted) missing.push('grant consent');
      if (
        submissionGpsConfig?.enabled &&
        submissionGpsConfig.required &&
        submissionGps === null
      )
        missing.push('capture submission GPS');
      const detail =
        missing.length > 0
          ? `Please ${missing.join(', ')} and fix any highlighted fields.`
          : 'Please fix the highlighted errors before submitting.';
      setSubmitError(detail);
      return;
    }
    setSubmitError(null);
    setLoading(true);
    try {
      const responseData = buildResponseData('submitted');
      let savedId: string;
      if (existingId) {
        await updateDoc(doc(db, 'questionnaireResponses', existingId), responseData as any);
        savedId = existingId;
      } else {
        const docRef = await addDoc(collection(db, 'questionnaireResponses'), responseData);
        savedId = docRef.id;
      }
      onSubmit?.({ ...(responseData as any), id: savedId } as QuestionnaireResponse);
      alert('Questionnaire submitted successfully!');
      onClose();
    } catch (error) {
      try {
        handleFirestoreError(
          error,
          existingId ? OperationType.UPDATE : OperationType.CREATE,
          'questionnaireResponses'
        );
      } catch (logged) {
        setSubmitError(friendlyError(logged));
      }
    } finally {
      setLoading(false);
    }
  };

  // ---- layout chrome -----------------------------------------------------

  const panelClasses = isFullscreen
    ? // Fixed-height modal-style panel so the body scrolls *inside* the form
      // (visible scrollbar, sticky header & action bar) rather than the page.
      'flex flex-col w-full max-w-3xl mx-auto bg-white rounded-none sm:rounded-xl shadow-xl border border-gray-200 h-[100dvh] sm:h-[92dvh] overflow-hidden'
    : 'flex flex-col h-full bg-white shadow-2xl border-l border-gray-200 w-full md:w-96';

  const submissionGpsForm: GpsCaptureSettings | undefined = submissionGpsConfig?.enabled
    ? {
        accuracyMeters: submissionGpsConfig.accuracyMeters,
        stabilizationSeconds: submissionGpsConfig.stabilizationSeconds,
        required: submissionGpsConfig.required,
        autoStart: submissionGpsConfig.autoStart,
        allowManualOverride: submissionGpsConfig.allowManualOverride
      }
    : undefined;

  const body = (
    <div className={panelClasses}>
      {/* Header */}
      <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between bg-gradient-to-r from-blue-50 to-indigo-50 sm:rounded-t-xl shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <FileText size={18} className="text-blue-600 shrink-0" />
          <div className="min-w-0">
            <h2 className="font-bold text-slate-900 truncate flex items-center gap-2">
              <span className="truncate">{questionnaire.title || 'Untitled Questionnaire'}</span>
              {readOnly ? (
                <span className="text-[9px] font-bold uppercase tracking-wider bg-slate-100 text-slate-600 border border-slate-200 px-1.5 py-0.5 rounded shrink-0">
                  View only
                </span>
              ) : isResuming ? (
                <span className="text-[9px] font-bold uppercase tracking-wider bg-amber-100 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded shrink-0">
                  Resuming draft
                </span>
              ) : null}
            </h2>
            <p className="text-[11px] text-slate-500 truncate">
              v{questionnaire.version || '1.0'} •{' '}
              {visibleQuestions.filter((q) => q.type !== 'section').length} visible question
              {visibleQuestions.filter((q) => q.type !== 'section').length === 1 ? '' : 's'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 text-slate-500 hover:bg-white/60 rounded-lg shrink-0"
          title="Close"
        >
          <X size={18} />
        </button>
      </div>

      {/* Progress bar */}
      {settings.showProgress !== false && (
        <div className="px-5 py-2 border-b border-slate-100 bg-white shrink-0">
          <div className="flex justify-between text-[10px] font-semibold text-slate-500 mb-1">
            <span>Progress</span>
            <span>{progress}%</span>
          </div>
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-600 transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Location strip (when captured up-front by geospatial flow) */}
      {currentLocation && (
        <div className="px-5 py-2 bg-blue-50/60 border-b border-blue-100 text-[11px] text-slate-700 flex items-center gap-1.5 shrink-0">
          <MapPin size={12} />
          <span>
            {currentLocation.lat.toFixed(6)}, {currentLocation.lng.toFixed(6)}
            {currentLocation.ward && <> · Ward {currentLocation.ward}</>}
          </span>
        </div>
      )}

      {/* Submit-level error banner */}
      {submitError && (
        <div className="px-5 pt-3 shrink-0">
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-xs flex items-start gap-2">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <p className="flex-1 break-words">{submitError}</p>
          </div>
        </div>
      )}

      {/* Scrollable body — `qc-panel-scroll` forces a visible (non-overlay)
          scrollbar on Windows so enumerators always see that more content
          is below. The whole body is wrapped in a `<fieldset>` so passing
          `readOnly` disables every nested native input in one stroke (and
          CSS dims them so it's visually obvious). */}
      <fieldset
        disabled={readOnly}
        className={`qc-panel-scroll flex-1 overflow-y-auto px-5 py-4 space-y-5 border-0 p-0 ${
          readOnly ? '[&_input]:cursor-not-allowed [&_select]:cursor-not-allowed [&_textarea]:cursor-not-allowed' : ''
        }`}
      >
        {/* Rich description (falls back to plain `description` if no blocks) */}
        {descriptionBlocks.length > 0 ? (
          <div className="border-b border-slate-100 pb-4">
            <DescriptionRenderer blocks={descriptionBlocks} />
          </div>
        ) : questionnaire.description ? (
          <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap border-b border-slate-100 pb-4">
            {questionnaire.description}
          </p>
        ) : null}

        {/* Enumerator info table */}
        {enumeratorInfoConfig?.enabled && enumeratorInfoConfig.fields.length > 0 && (
          <div>
            <EnumeratorInfoTable
              info={enumeratorInfoConfig}
              answers={enumeratorInfo}
              onChange={handleEnumeratorChange}
            />
            {Object.keys(enumeratorErrors).length > 0 && (
              <p className="text-[11px] text-red-600 mt-2 flex items-center gap-1">
                <AlertCircle size={12} />
                Some required enumerator info fields are missing.
              </p>
            )}
          </div>
        )}

        {/* Consent gate */}
        {consentGate?.enabled && (
          <ConsentGateForm
            gate={consentGate}
            granted={consentGranted}
            onChange={handleConsentChange}
          />
        )}

        {/* Questions (only after gate accepted) */}
        {!questionsUnlocked ? (
          <div className="flex items-center justify-center gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
            <Lock size={16} />
            Tick the consent checkbox to start the survey.
          </div>
        ) : visibleQuestions.length === 0 ? (
          <p className="text-sm text-slate-500 italic">No questions to show.</p>
        ) : (
          <>
            {/* Per-type counter so the number prefix in front of each question
                ignores `section` dividers (those render their own heading and
                don't take a Q number). */}
            {(() => {
              let qIndex = -1;
              return visibleQuestions.map((q) => {
                if (q.type !== 'section') qIndex += 1;
                const locked = lockedQuestionIds.has(q.id);
                return (
                  <div key={q.id}>
                    {/* Lock-mode default-value rule is active for this
                        question — disable inputs so the value can't be
                        edited, and surface a small "Auto" hint so it's
                        clear *why* the field doesn't accept input. The
                        existing `RuntimeQuestion` doesn't take a
                        disabled prop, but `<fieldset disabled>` cleanly
                        cascades the disabled state to every nested
                        native input/select/textarea (same trick the
                        admin-side read-only mode uses). */}
                    <fieldset
                      disabled={locked}
                      className={
                        locked
                          ? 'relative [&_input]:cursor-not-allowed [&_select]:cursor-not-allowed [&_textarea]:cursor-not-allowed [&_input:disabled]:bg-slate-50 [&_select:disabled]:bg-slate-50 [&_textarea:disabled]:bg-slate-50'
                          : undefined
                      }
                    >
                      <RuntimeQuestion
                        index={qIndex}
                        question={q}
                        value={responses[q.id]}
                        onChange={(v) => handleAnswer(q.id, v)}
                      />
                      {locked && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-1.5 py-0.5 mt-1">
                          Auto-filled (locked by rule)
                        </span>
                      )}
                    </fieldset>
                    {errors[q.id] && (
                      <p className="text-xs text-red-600 flex items-center gap-1 mt-1">
                        <AlertCircle size={12} />
                        {errors[q.id]}
                      </p>
                    )}
                  </div>
                );
              });
            })()}

            {/* End-of-survey GPS capture. In read-only mode we show a
                static summary of the captured point instead of the live
                widget (which would offer "Re-capture" / restart actions). */}
            {submissionGpsForm && submissionGpsConfig && !readOnly && (
              <SubmissionGpsCaptureWidget
                config={submissionGpsForm}
                title={submissionGpsConfig.title}
                description={submissionGpsConfig.description}
                onChange={(s) => setSubmissionGps(s)}
              />
            )}
            {readOnly && submissionGps && (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-4 text-sm">
                <div className="text-[10px] font-bold text-emerald-700 uppercase tracking-wider mb-1">
                  Submission GPS
                </div>
                <div className="text-slate-800 font-mono text-xs">
                  {submissionGps.lat.toFixed(6)}, {submissionGps.lng.toFixed(6)}{' '}
                  <span className="text-slate-500">
                    (±{submissionGps.accuracy.toFixed(1)} m)
                  </span>
                </div>
              </div>
            )}
          </>
        )}
      </fieldset>

      {/* Action bar (sibling to the scrollable body — always visible).
          Hidden entirely in read-only mode; the parent owns the close
          control via the X button in the header. */}
      {!readOnly && (
        <div className="px-5 py-3 border-t border-slate-200 bg-white sm:rounded-b-xl shrink-0">
          <div className="flex gap-2">
            {settings.allowSaveDraft !== false && (
              <button
                type="button"
                onClick={handleSaveDraft}
                disabled={loading}
                className="flex-1 bg-slate-100 text-slate-700 font-semibold py-2.5 rounded-lg hover:bg-slate-200 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Save size={16} />
                {loading ? 'Saving…' : 'Save Draft'}
              </button>
            )}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={loading || (consentGate?.enabled && !consentGranted)}
              className="flex-1 bg-blue-600 text-white font-semibold py-2.5 rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Send size={16} />
              {loading ? 'Submitting…' : 'Submit'}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  if (isFullscreen) {
    return (
      // Fixed-viewport stage. The form panel inside has its own internal
      // scroll (`qc-panel-scroll` on the body) so the page itself never
      // scrolls — that keeps the scrollbar tied to the form content.
      <div className="flex flex-col w-full h-[100dvh] bg-slate-50 overflow-hidden py-0 sm:py-6">
        {body}
      </div>
    );
  }
  return body;
};
