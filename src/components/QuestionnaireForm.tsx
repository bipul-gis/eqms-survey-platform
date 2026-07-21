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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthProvider';
import {
  Questionnaire,
  QuestionnaireResponse,
  Question,
  GpsCaptureSettings,
  SubmissionGpsCapture
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
  isDeviceOffline
} from '../lib/offlineFirestore';
import { DEFAULT_PROJECT_ID } from '../lib/projects';
import { resolveAssignedSlumRecords } from '../lib/assignedSlums';
import {
  collectDwellingIdFieldIds,
  collectSlumNameFieldIds,
  collectWardAreaFieldIds
} from '../lib/questionnaireSlumFields';
import { wardValueFromSlumCsv } from '../lib/slumRegistry';
import {
  allocateNextDwellingId,
  dwellingFieldsAreEmpty,
  invalidateDwellingIdCache,
  mergeDwellingIntoAnswerMaps
} from '../lib/slumDwellingSequence';
import { enumeratorResolvedDisplayName } from '../lib/userDisplayName';
import {
  buildInitialEnumeratorInfo,
  collectEnumeratorIdentityFieldIds,
  syncEnumeratorIdentityAnswers
} from '../lib/enumeratorIdentityFields';
import { evaluateComputed } from '../lib/computedAnswers';
import { choiceAnswerIsEmpty, choiceAnswerIsFilled } from '../lib/choiceAnswers';
import {
  matrixAllRowsAnswered,
  validateMatrixQuestion
} from '../lib/matrixAnswers';
import {
  ConsentGateForm,
  DescriptionRenderer,
  EnumeratorInfoTable,
  RuntimeQuestion,
  SubmissionGpsCaptureWidget,
  computeAppliedDefaultRules,
  ensureOptionShape,
  evaluateLogic,
  isChoiceOptionDisabled,
  isPhotoAnswerFilled,
  ruleValueMatchesCurrent
} from './QuestionnaireRuntime';
import { geosurveyApi } from '../lib/geosurveyApi';
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
  /** Used to resolve slum task assignment (`projectSlumAssignments`). */
  projectId?: string;
  /** When true, always create a fresh response doc (ignore session draft id). */
  forceNew?: boolean;
}

interface CapturedGps {
  lat: number;
  lng: number;
  accuracy: number;
  durationSeconds: number;
}

  /** Remove `undefined` values from API payloads. */
const stripUndefined = <T extends Record<string, any>>(obj: T): T => {
  const out = {} as Record<string, any>;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
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
const validateQuestion = (
  q: Question,
  value: unknown,
  answers: Record<string, unknown>
): string | null => {
  if (q.type === 'section') return null;

  const matrixErr = validateMatrixQuestion(q, value);
  if (matrixErr) return matrixErr;

  const isEmpty =
    q.type === 'photo'
      ? !isPhotoAnswerFilled(value)
      : q.type === 'select' || q.type === 'radio'
      ? choiceAnswerIsEmpty(value)
      : value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0);
  // `computed` answers are auto-filled by the form layer from the
  // operand answers. Showing a "This field is required" warning on
  // them would be confusing because the enumerator can't type into
  // the field anyway — the right cue is "fill the operands". Surface
  // a friendlier message instead.
  if (q.type === 'computed') {
    if (q.required && isEmpty) {
      return 'Fill the questions that feed this calculation.';
    }
    return null;
  }
  if (q.required && isEmpty) return 'This field is required';

  if (q.type === 'select' || q.type === 'radio') {
    if (typeof value === 'string' && value) {
      const opts = ensureOptionShape(q.options);
      const opt = opts.find((o) => o.value === value);
      if (opt && isChoiceOptionDisabled(opt, answers)) {
        return 'This option is not available given your other answers. Please choose again.';
      }
    }
  }
  if (q.type === 'multiselect' || q.type === 'checkbox') {
    const arr = Array.isArray(value) ? (value as string[]) : [];
    const opts = ensureOptionShape(q.options);
    for (const s of arr) {
      const opt = opts.find((o) => o.value === s);
      if (opt && isChoiceOptionDisabled(opt, answers)) {
        return 'One or more selected options are not available given your other answers.';
      }
    }
  }

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
  readOnly = false,
  projectId: projectIdProp,
  forceNew = false
}) => {
  const { user, userProfile } = useAuth();
  const projectId = projectIdProp || questionnaire.projectId || DEFAULT_PROJECT_ID;
  const isFullscreen = variant === 'fullscreen';

  const draftStorageKey =
    user?.uid && questionnaire.id
      ? `qc-draft:${user.uid}:${questionnaire.id}`
      : null;

  const resolveInitialDraftId = (): string | undefined => {
    if (forceNew) return undefined;
    if (existingResponse?.id) return existingResponse.id;
    if (draftStorageKey && typeof sessionStorage !== 'undefined') {
      try {
        return sessionStorage.getItem(draftStorageKey) || undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  };

  /** Synchronous id — prevents duplicate docs when Save is tapped twice quickly. */
  const draftDocIdRef = useRef<string | undefined>(resolveInitialDraftId());
  const [savedResponseId, setSavedResponseId] = useState<string | undefined>(
    () => draftDocIdRef.current
  );
  const persistInFlightRef = useRef(false);

  useEffect(() => {
    if (forceNew) {
      draftDocIdRef.current = undefined;
      setSavedResponseId(undefined);
      if (draftStorageKey) {
        try {
          sessionStorage.removeItem(draftStorageKey);
        } catch {
          /* ignore */
        }
      }
      return;
    }
    const id = resolveInitialDraftId();
    draftDocIdRef.current = id;
    setSavedResponseId(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionnaire.id, user?.uid, existingResponse?.id, forceNew]);

  const isResumingDraft = !!(existingResponse || savedResponseId || draftDocIdRef.current);

  const [responses, setResponses] = useState<Record<string, any>>(
    () => existingResponse?.responses || {}
  );
  // Lazy init so the "now" snapshot is taken when the form first mounts.
  // Identity fields (name / id / phone / email) always come from the signed-in
  // account and stay locked. Date/time fields get "now" on new surveys; drafts
  // keep their original survey-start values for non-identity rows.
  const [enumeratorInfo, setEnumeratorInfo] = useState<Record<string, any>>(() => {
    const fields = questionnaire.enumeratorInfo?.fields;
    const base = existingResponse?.enumeratorInfo
      ? { ...existingResponse.enumeratorInfo }
      : buildInitialEnumeratorInfo(fields, userProfile, user);
    return {
      ...base,
      ...syncEnumeratorIdentityAnswers(fields, userProfile, user)
    };
  });
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
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'submitting'>('idle');
  const [currentLocation, setCurrentLocation] = useState(
    existingResponse?.location || initialLocation
  );

  useEffect(() => {
    if (initialLocation && !existingResponse?.location) setCurrentLocation(initialLocation);
  }, [initialLocation, existingResponse?.location]);

  // Questionnaire-level config — preserve old default behaviour when missing.
  // Only fields the admin added in the builder appear here (no runtime injection).
  const descriptionBlocks = questionnaire.descriptionBlocks || [];
  const conclusionBlocks = questionnaire.conclusionBlocks || [];
  const enumeratorInfoConfig = questionnaire.enumeratorInfo;
  const consentGate = questionnaire.consentGate;
  const submissionGpsConfig: SubmissionGpsCapture | undefined = questionnaire.submissionGps;
  const settings = questionnaire.settings || {};

  // Keep locked identity answers mirrored to the live profile (covers late
  // profile load and resumed drafts that previously had editable values).
  useEffect(() => {
    if (readOnly) return;
    const patch = syncEnumeratorIdentityAnswers(
      enumeratorInfoConfig?.fields,
      userProfile,
      user
    );
    if (Object.keys(patch).length === 0) return;
    setEnumeratorInfo((prev) => {
      let dirty = false;
      const next = { ...prev };
      for (const [k, v] of Object.entries(patch)) {
        if (next[k] !== v) {
          next[k] = v;
          dirty = true;
        }
      }
      return dirty ? next : prev;
    });
  }, [readOnly, enumeratorInfoConfig?.fields, userProfile, user]);

  // Gate: questions only revealed once consent ticked (when consent is enabled).
  const questionsUnlocked = !consentGate?.enabled || consentGranted;

  // Visible questions respect display logic AND the consent gate.
  const visibleQuestions = useMemo(() => {
    const all = questionnaire.questions || [];
    // Compute logic visibility per question first.
    const visibleById = new Map<string, boolean>();
    for (const q of all) visibleById.set(q.id, evaluateLogic(q.logic, responses));
    // A sub-question is hidden whenever its parent is hidden — saves
    // admins from having to mirror the parent's logic rule on every
    // child. Top-level questions follow their own rule only.
    return all.filter((q) => {
      if (!visibleById.get(q.id)) return false;
      if (q.parentId) {
        const parentVisible = visibleById.get(q.parentId);
        if (parentVisible === false) return false;
      }
      return true;
    });
  }, [questionnaire.questions, responses]);

  /** Merged map for cross-field rules (enumerator info + survey answers). */
  const answersForOptionLogic = useMemo(
    () => ({ ...enumeratorInfo, ...responses }),
    [enumeratorInfo, responses]
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

  // Auto-write `computed`-question results into `responses` so the
  // calculated value is what we save (CSV export, admin review) and
  // not "blank". Recomputed every render but the actual setState only
  // fires when a value drifts, preventing render loops with the
  // operand inputs.
  useEffect(() => {
    if (readOnly) return;
    const computedQuestions = visibleQuestions.filter(
      (q) => q.type === 'computed' && q.computed
    );
    if (computedQuestions.length === 0) return;
    const patch: Record<string, unknown> = {};
    for (const q of computedQuestions) {
      const res = evaluateComputed(q.computed, responses, visibleQuestions);
      const next = res.value;
      const current = responses[q.id];
      const same =
        (next === null && (current === undefined || current === null || current === '')) ||
        (next !== null && current === next);
      if (!same) {
        patch[q.id] = next === null ? '' : next;
      }
    }
    if (Object.keys(patch).length === 0) return;
    setResponses((prev) => ({ ...prev, ...patch }));
  }, [visibleQuestions, responses, readOnly]);

  // Lock-mode rules disable the corresponding input so enumerators can't
  // edit a value the admin has explicitly tied to another answer. Held
  // as a Set so the JSX render path can do an O(1) lookup per question.
  const assignedSlumRecords = useMemo(
    () => resolveAssignedSlumRecords(userProfile, projectId),
    [userProfile, projectId]
  );
  const primaryAssignedSlum = assignedSlumRecords.length > 0 ? assignedSlumRecords[0] : null;

  const slumAutoFieldIds = useMemo(() => {
    if (!primaryAssignedSlum) return new Set<string>();
    const ids = [
      ...collectSlumNameFieldIds(questionnaire.enumeratorInfo?.fields),
      ...collectSlumNameFieldIds(questionnaire.questions),
      ...collectWardAreaFieldIds(questionnaire.enumeratorInfo?.fields),
      ...collectWardAreaFieldIds(questionnaire.questions),
      ...collectDwellingIdFieldIds(questionnaire.enumeratorInfo?.fields),
      ...collectDwellingIdFieldIds(questionnaire.questions)
    ];
    return new Set(ids);
  }, [primaryAssignedSlum, questionnaire.enumeratorInfo?.fields, questionnaire.questions]);

  const slumAutoInitRef = useRef(false);
  const enumDwellingFieldIds = useMemo(
    () => collectDwellingIdFieldIds(questionnaire.enumeratorInfo?.fields),
    [questionnaire.enumeratorInfo?.fields]
  );
  const questionDwellingFieldIds = useMemo(
    () => collectDwellingIdFieldIds(questionnaire.questions),
    [questionnaire.questions]
  );

  useEffect(() => {
    slumAutoInitRef.current = false;
  }, [questionnaire.id, savedResponseId, forceNew]);

  useEffect(() => {
    if (readOnly || existingResponse || !primaryAssignedSlum || slumAutoInitRef.current) return;

    const slumName = primaryAssignedSlum.slumName;
    const wardLabel = wardValueFromSlumCsv(primaryAssignedSlum.wardName);
    const slumNameFieldIds = [
      ...collectSlumNameFieldIds(questionnaire.enumeratorInfo?.fields),
      ...collectSlumNameFieldIds(questionnaire.questions)
    ];
    const wardAreaFieldIds = [
      ...collectWardAreaFieldIds(questionnaire.enumeratorInfo?.fields),
      ...collectWardAreaFieldIds(questionnaire.questions)
    ];
    const dwellingFieldIds = [
      ...collectDwellingIdFieldIds(questionnaire.enumeratorInfo?.fields),
      ...collectDwellingIdFieldIds(questionnaire.questions)
    ];

    if (slumNameFieldIds.length === 0 && wardAreaFieldIds.length === 0 && dwellingFieldIds.length === 0) {
      return;
    }

    slumAutoInitRef.current = true;

    const applyIfEmpty = (prev: Record<string, unknown>, fieldIds: string[], value: string) => {
      const next = { ...prev };
      for (const id of fieldIds) {
        if (next[id] === undefined || next[id] === null || next[id] === '') {
          next[id] = value;
        }
      }
      return next;
    };

    const patchEnumerator = (fieldIds: string[], value: string) => {
      if (fieldIds.length === 0) return;
      setEnumeratorInfo((prev) => applyIfEmpty(prev, fieldIds, value));
    };

    const patchQuestions = (fieldIds: string[], value: string) => {
      if (fieldIds.length === 0) return;
      setResponses((prev) => applyIfEmpty(prev, fieldIds, value));
    };

    const enumSlum = collectSlumNameFieldIds(questionnaire.enumeratorInfo?.fields);
    const qSlum = collectSlumNameFieldIds(questionnaire.questions);
    patchEnumerator(enumSlum, slumName);
    patchQuestions(qSlum, slumName);

    if (wardLabel) {
      const enumWard = collectWardAreaFieldIds(questionnaire.enumeratorInfo?.fields);
      const qWard = collectWardAreaFieldIds(questionnaire.questions);
      patchEnumerator(enumWard, wardLabel);
      patchQuestions(qWard, wardLabel);
    }

    if (dwellingFieldIds.length === 0 || !user?.uid) return;

    const patchDwelling = (dwellingValue: string) => {
      if (enumDwellingFieldIds.length > 0) {
        setEnumeratorInfo((prev) =>
          mergeDwellingIntoAnswerMaps(
            dwellingValue,
            enumDwellingFieldIds,
            [],
            prev,
            {}
          ).enumeratorInfo
        );
      }
      if (questionDwellingFieldIds.length > 0) {
        setResponses((prev) =>
          mergeDwellingIntoAnswerMaps(
            dwellingValue,
            [],
            questionDwellingFieldIds,
            {},
            prev
          ).responses
        );
      }
    };

    let cancelled = false;
    void (async () => {
      try {
        const nextId = await allocateNextDwellingId(
          questionnaire.id,
          primaryAssignedSlum.slumId,
          user.uid,
          draftDocIdRef.current
        );
        if (cancelled) return;
        patchDwelling(nextId);
      } catch (e) {
        console.warn('QuestionnaireForm: dwelling id auto-fill failed', e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    readOnly,
    existingResponse,
    primaryAssignedSlum,
    questionnaire.id,
    questionnaire.enumeratorInfo?.fields,
    questionnaire.questions,
    user?.uid,
    enumDwellingFieldIds,
    questionDwellingFieldIds
  ]);

  const lockedQuestionIds = useMemo(() => {
    const ids = new Set<string>(slumAutoFieldIds);
    for (const r of appliedDefaultRules) {
      if (r.mode === 'lock') ids.add(r.questionId);
    }
    return ids;
  }, [appliedDefaultRules, slumAutoFieldIds]);

  const identityEnumeratorFieldIds = useMemo(
    () => collectEnumeratorIdentityFieldIds(enumeratorInfoConfig?.fields),
    [enumeratorInfoConfig?.fields]
  );

  const lockedEnumeratorFieldIds = useMemo(() => {
    const ids = new Set<string>(identityEnumeratorFieldIds);
    if (primaryAssignedSlum) {
      for (const id of [
        ...collectSlumNameFieldIds(enumeratorInfoConfig?.fields),
        ...collectWardAreaFieldIds(enumeratorInfoConfig?.fields),
        ...collectDwellingIdFieldIds(enumeratorInfoConfig?.fields)
      ]) {
        if (slumAutoFieldIds.has(id)) ids.add(id);
      }
    }
    return ids.size > 0 ? ids : undefined;
  }, [
    identityEnumeratorFieldIds,
    primaryAssignedSlum,
    enumeratorInfoConfig?.fields,
    slumAutoFieldIds
  ]);

  const enumeratorLockReasons = useMemo(() => {
    const reasons: Record<string, string> = {};
    for (const id of identityEnumeratorFieldIds) {
      reasons[id] = 'Auto-filled from your account';
    }
    if (primaryAssignedSlum) {
      for (const id of [
        ...collectSlumNameFieldIds(enumeratorInfoConfig?.fields),
        ...collectWardAreaFieldIds(enumeratorInfoConfig?.fields),
        ...collectDwellingIdFieldIds(enumeratorInfoConfig?.fields)
      ]) {
        if (slumAutoFieldIds.has(id)) {
          reasons[id] = 'Auto-filled from your slum assignment';
        }
      }
    }
    return reasons;
  }, [
    identityEnumeratorFieldIds,
    primaryAssignedSlum,
    enumeratorInfoConfig?.fields,
    slumAutoFieldIds
  ]);

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
      if (q.type === 'matrix') return matrixAllRowsAnswered(v, q.rows);
      if (q.type === 'select' || q.type === 'radio') return choiceAnswerIsFilled(v);
      if (q.type === 'photo') return isPhotoAnswerFilled(v);
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
    // Identity rows are profile-backed and never editable by enumerators.
    if (identityEnumeratorFieldIds.has(fieldId)) return;
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
      const err = validateQuestion(f, enumeratorInfo[f.id], answersForOptionLogic);
      if (err) newE[f.id] = err;
    }

    if (questionsUnlocked) {
      for (const q of visibleQuestions) {
        const err = validateQuestion(q, responses[q.id], answersForOptionLogic);
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
   * Build the response payload for the GeoSurvey API.
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
    if (userProfile?.email) base.respondentEmail = userProfile.email;
    const respondentLabel = enumeratorResolvedDisplayName(userProfile, user);
    if (respondentLabel) base.respondentName = respondentLabel;
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
    if (status === 'submitted') base.submittedAt = new Date().toISOString();
    base.updatedAt = new Date().toISOString();
    return stripUndefined(base) as Omit<QuestionnaireResponse, 'id'>;
  };

  const rememberDraftDocId = (id: string) => {
    draftDocIdRef.current = id;
    setSavedResponseId(id);
    if (draftStorageKey) {
      try {
        sessionStorage.setItem(draftStorageKey, id);
      } catch {
        /* ignore quota / private mode */
      }
    }
  };

  const clearRememberedDraftDocId = () => {
    draftDocIdRef.current = undefined;
    setSavedResponseId(undefined);
    if (draftStorageKey) {
      try {
        sessionStorage.removeItem(draftStorageKey);
      } catch {
        /* ignore */
      }
    }
  };

  const applyDwellingIdBeforeSave = async (
    data: Omit<QuestionnaireResponse, 'id'>,
    status: 'draft' | 'submitted',
    excludeResponseId?: string
  ): Promise<Omit<QuestionnaireResponse, 'id'>> => {
    if (!primaryAssignedSlum || !user?.uid) return data;
    if (enumDwellingFieldIds.length === 0 && questionDwellingFieldIds.length === 0) return data;

    const reallocate =
      status === 'submitted' ||
      dwellingFieldsAreEmpty(
        enumDwellingFieldIds,
        questionDwellingFieldIds,
        data.enumeratorInfo,
        data.responses
      );
    if (!reallocate) return data;

    try {
      const nextId = await allocateNextDwellingId(
        questionnaire.id,
        primaryAssignedSlum.slumId,
        user.uid,
        excludeResponseId
      );
      const merged = mergeDwellingIntoAnswerMaps(
        nextId,
        enumDwellingFieldIds,
        questionDwellingFieldIds,
        data.enumeratorInfo || {},
        data.responses || {}
      );
      if (enumDwellingFieldIds.length > 0) setEnumeratorInfo(merged.enumeratorInfo);
      if (questionDwellingFieldIds.length > 0) setResponses(merged.responses);
      return {
        ...data,
        enumeratorInfo:
          enumDwellingFieldIds.length > 0 ? merged.enumeratorInfo : data.enumeratorInfo,
        responses: questionDwellingFieldIds.length > 0 ? merged.responses : data.responses
      };
    } catch (e) {
      console.warn('QuestionnaireForm: dwelling id allocation before save failed', e);
      return data;
    }
  };

  const persistResponse = async (status: 'draft' | 'submitted'): Promise<string> => {
    const existingId = draftDocIdRef.current;
    let responseData = buildResponseData(status);
    responseData = await applyDwellingIdBeforeSave(responseData, status, existingId);
    const optimisticId = existingId || `resp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    if (!existingId) {
      rememberDraftDocId(optimisticId);
    }

    try {
      const saved = await geosurveyApi.saveResponse(
        existingId ? { ...responseData, id: existingId } : responseData
      );
      const savedId = String((saved as { id?: string }).id ?? optimisticId);
      rememberDraftDocId(savedId);
      if (status === 'submitted' && draftStorageKey) {
        try {
          sessionStorage.removeItem(draftStorageKey);
        } catch {
          /* ignore */
        }
      }
      return savedId;
    } catch (error) {
      if (!existingId) clearRememberedDraftDocId();
      throw error;
    }
  };

  const handleSaveDraft = async () => {
    if (!user) {
      setSubmitError('You must be signed in to save a draft.');
      return;
    }
    if (persistInFlightRef.current || saveState !== 'idle') return;
    persistInFlightRef.current = true;
    setSubmitError(null);
    setSaveState('saving');
    try {
      await persistResponse('draft');
      invalidateDwellingIdCache(questionnaire.id);
      const offline = await isDeviceOffline();
      alert(
        offline
          ? 'Draft saved on this device. It will sync automatically once you reconnect.'
          : 'Draft saved successfully!'
      );
    } catch (error) {
      setSubmitError(friendlyError(error));
    } finally {
      persistInFlightRef.current = false;
      setSaveState('idle');
    }
  };

  const handleSubmit = async () => {
    if (!user) {
      setSubmitError('You must be signed in to submit.');
      return;
    }
    if (persistInFlightRef.current || saveState !== 'idle') return;
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
    persistInFlightRef.current = true;
    setSubmitError(null);
    setSaveState('submitting');
    try {
      const responseData = buildResponseData('submitted');
      const savedId = await persistResponse('submitted');
      invalidateDwellingIdCache(questionnaire.id);
      onSubmit?.({ ...(responseData as any), id: savedId } as QuestionnaireResponse);
      const offline = await isDeviceOffline();
      alert(
        offline
          ? 'Submission saved on this device. It will upload automatically once you reconnect — no need to resubmit.'
          : 'Questionnaire submitted successfully!'
      );
      onClose();
    } catch (error) {
      setSubmitError(friendlyError(error));
    } finally {
      persistInFlightRef.current = false;
      setSaveState('idle');
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
      <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between bg-gradient-to-r from-blue-50 to-indigo-50 sm:rounded-t-xl shrink-0 pt-safe-top">
        <div className="flex items-center gap-2 min-w-0">
          <FileText size={18} className="text-blue-600 shrink-0" />
          <div className="min-w-0">
            <h2 className="font-bold text-slate-900 truncate flex items-center gap-2">
              <span className="truncate">{questionnaire.title || 'Untitled Questionnaire'}</span>
              {readOnly ? (
                <span className="text-[9px] font-bold uppercase tracking-wider bg-slate-100 text-slate-600 border border-slate-200 px-1.5 py-0.5 rounded shrink-0">
                  View only
                </span>
              ) : isResumingDraft ? (
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
              logicAnswers={answersForOptionLogic}
              onChange={handleEnumeratorChange}
              lockedFieldIds={lockedEnumeratorFieldIds}
              lockReasons={enumeratorLockReasons}
            />
            {primaryAssignedSlum && (
              <p className="text-[11px] text-slate-500 mt-2">
                Slum assignment:{' '}
                <span className="font-medium text-slate-700">{primaryAssignedSlum.slumName}</span>
                {wardValueFromSlumCsv(primaryAssignedSlum.wardName) && (
                  <>
                    {' '}
                    · <span className="font-medium text-slate-700">
                      {wardValueFromSlumCsv(primaryAssignedSlum.wardName)}
                    </span>
                  </>
                )}
                {assignedSlumRecords.length > 1 && (
                  <span className="text-amber-700"> (using first of {assignedSlumRecords.length} assigned slums)</span>
                )}
              </p>
            )}
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
            enumeratorDisplayName={enumeratorResolvedDisplayName(userProfile, user)}
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
            {/* Hierarchical render: top-level questions first, each
                followed by their sub-questions inline (indented). The
                numbering pre-computed here mirrors what the builder
                shows (Q 1, then 1.a / 1.b under Q 1). */}
            {(() => {
              type Slot = { q: Question; label: string; depth: 0 | 1 };
              const slots: Slot[] = [];
              let topNum = 0;
              for (const q of visibleQuestions) {
                if (q.parentId) continue;
                if (q.type !== 'section') topNum += 1;
                slots.push({ q, label: String(topNum), depth: 0 });
                if (q.type === 'section') continue;
                const children = visibleQuestions.filter(
                  (c) => c.parentId === q.id && c.type !== 'section'
                );
                children.forEach((c, ci) => {
                  const letter = String.fromCharCode(97 + ci);
                  slots.push({ q: c, label: `${topNum}.${letter}`, depth: 1 });
                });
              }
              return slots.map(({ q, label, depth }) => {
                const locked = lockedQuestionIds.has(q.id);
                return (
                  <div
                    key={q.id}
                    className={depth > 0 ? 'ml-5 pl-4 border-l-2 border-blue-200' : undefined}
                  >
                    <fieldset
                      disabled={locked}
                      className={
                        locked
                          ? 'relative [&_input]:cursor-not-allowed [&_select]:cursor-not-allowed [&_textarea]:cursor-not-allowed [&_input:disabled]:bg-slate-50 [&_select:disabled]:bg-slate-50 [&_textarea:disabled]:bg-slate-50'
                          : undefined
                      }
                    >
                      <RuntimeQuestion
                        index={0}
                        numberLabel={q.type === 'section' ? '' : label}
                        question={q}
                        value={responses[q.id]}
                        onChange={(v) => handleAnswer(q.id, v)}
                        allAnswers={answersForOptionLogic}
                        allQuestions={visibleQuestions}
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

            {questionsUnlocked &&
              (conclusionBlocks.length > 0 || questionnaire.conclusion?.trim()) && (
                <div className="rounded-lg border border-slate-200 bg-slate-50/80 px-4 py-3 space-y-2">
                  <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                    Conclusion
                  </div>
                  {conclusionBlocks.length > 0 ? (
                    <DescriptionRenderer blocks={conclusionBlocks} />
                  ) : (
                    <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                      {questionnaire.conclusion}
                    </p>
                  )}
                </div>
              )}

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
                disabled={saveState !== 'idle'}
                className="flex-1 bg-slate-100 text-slate-700 font-semibold py-2.5 rounded-lg hover:bg-slate-200 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Save size={16} />
                {saveState === 'saving' ? 'Saving…' : 'Save Draft'}
              </button>
            )}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={saveState !== 'idle' || (consentGate?.enabled && !consentGranted)}
              className="flex-1 bg-blue-600 text-white font-semibold py-2.5 rounded-lg hover:bg-blue-700 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Send size={16} />
              {saveState === 'submitting' ? 'Submitting…' : 'Submit'}
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
