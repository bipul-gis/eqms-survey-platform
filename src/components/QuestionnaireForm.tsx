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
import { useGeoLocation } from './GeoLocationProvider';
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
import {
  allocateNextResponseId,
  collapseAccidentalResponseIdQuestions,
  inferResponseIdPrefixQuestionId,
  invalidateResponseIdCache,
  isAllocatedResponseIdValue,
  mergeResponseIdIntoAnswers,
  resolveResponseIdPrefix,
  responseIdMatchesPrefix
} from '../lib/responseIdSequence';
import { normalizeBanglaDigits, parseLocaleNumber } from '../lib/banglaDigits';
import { enumeratorResolvedDisplayName } from '../lib/userDisplayName';
import {
  buildInitialEnumeratorInfo,
  collectEnumeratorIdentityFieldIds,
  syncEnumeratorIdentityAnswers
} from '../lib/enumeratorIdentityFields';
import { evaluateComputed } from '../lib/computedAnswers';
import { normalizeQuestionnaireSectionQuestions } from '../lib/questionnaireSections';
import { buildQuestionNumbering, buildVisibleQuestionSlots } from '../lib/questionNumbering';
import { choiceAnswerIsEmpty, choiceAnswerIsFilled, isOtherSpecifyAnswer } from '../lib/choiceAnswers';
import {
  matrixAllRowsAnswered,
  validateMatrixQuestion
} from '../lib/matrixAnswers';
import {
  ConsentGateForm,
  DescriptionRenderer,
  EnumeratorInfoTable,
  RuntimeQuestion,
  getLocalizedText,
  SubmissionGpsCaptureWidget,
  type SurveyLanguage,
  computeAppliedDefaultRules,
  ensureOptionShape,
  evaluateLogic,
  isChoiceOptionUnavailable,
  isOtherChoiceUnavailable,
  isPhotoAnswerFilled,
  ruleValueMatchesCurrent
} from './QuestionnaireRuntime';
import { geosurveyApi } from '../lib/geosurveyApi';
import {
  ASSIGNED_ZONE_BUFFER_METERS,
  findZoneWithinDistance,
} from '../lib/pointInPolygon';
import { countPendingResponses } from '../lib/offlineResponses';
import type { ZonePolygon } from '../types';
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
  /** Assigned zone polygons — when strictGeofence, GPS must fall inside one. */
  geofenceZones?: ZonePolygon[];
  strictGeofence?: boolean;
  /** Admin configured GPS tolerance outside assigned zones, in meters. */
  geofenceBufferMeters?: number;
  /** Optional geospatial feature to link this response to */
  linkedFeature?: {
    id: string;
    type?: string;
    attributes?: Record<string, any>;
    surveyLayerKey?: string;
  };
}

interface CapturedGps {
  lat: number;
  lng: number;
  accuracy: number;
  durationSeconds: number;
  /** When the GPS reading was locked (ISO). */
  capturedAt?: string;
}

  /** Remove `undefined` values from API payloads. */
const stripUndefined = <T extends Record<string, any>>(obj: T): T => {
  const out = {} as Record<string, any>;
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
};

const isSurveyDateQuestion = (question: Question) => question.type === 'date' && [question.key, question.question]
  .filter(Boolean)
  .some((value) => String(value).normalize('NFKC').toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').includes('survey date'));

const todayAsLocalDate = () => {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
};

const linkedAttributeAnswers = (questionnaire: Questionnaire, attributes?: Record<string, any>, surveyLayerKey?: string) => {
  const sourceAttributes = attributes || {};
  const answers: Record<string, any> = Object.fromEntries(Object.entries(sourceAttributes).map(([key, value]) => [`linked_attribute:${key}`, value]));
  const values = new Map(Object.entries(sourceAttributes).map(([key, value]) => [key.trim().normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' '), value]));
  for (const question of questionnaire.questions || []) {
    if (isSurveyDateQuestion(question)) {
      answers[question.id] = todayAsLocalDate();
      continue;
    }
    const link = question.featureAttributeLink;
    const linkedValue = link && surveyLayerKey && link.layerKey.trim().normalize('NFKC').toLocaleLowerCase() === surveyLayerKey.trim().normalize('NFKC').toLocaleLowerCase()
      ? sourceAttributes[link.field]
      : undefined;
    if (linkedValue !== undefined && linkedValue !== null && linkedValue !== '') {
      answers[question.id] = linkedValue;
      continue;
    }
    const candidates = [question.key, question.id, question.question].filter((value): value is string => Boolean(value));
    const match = candidates.map((candidate) => values.get(candidate.trim().normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' '))).find((value) => value !== undefined && value !== null && value !== '');
    if (match === undefined) continue;
    if (['select', 'radio', 'multiselect', 'checkbox'].includes(question.type) && Array.isArray(question.options)) {
      const option = question.options.find((item) => typeof item === 'string'
        ? item.trim().toLocaleLowerCase() === String(match).trim().toLocaleLowerCase()
        : item.value.trim().toLocaleLowerCase() === String(match).trim().toLocaleLowerCase() || item.label.trim().toLocaleLowerCase() === String(match).trim().toLocaleLowerCase());
      if (!option) continue;
      const optionValue = typeof option === 'string' ? option : option.value;
      answers[question.id] = question.type === 'multiselect' || question.type === 'checkbox' ? [optionValue] : optionValue;
    } else {
      answers[question.id] = match;
    }
  }
  return answers;
};

/**
 * Reasonable RFC-5322-lite regex — accepts the formats users actually
 * type without dragging in a 200-line full RFC parser. Catches the most
 * common typos (missing `@`, missing TLD, illegal characters) which is
 * the whole point of validating in-form.
 */
const EMAIL_REGEX = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

/** Strip everything that isn't a digit so we can count phone digits regardless of formatting. */
const phoneDigitCount = (value: string): number =>
  normalizeBanglaDigits(value).replace(/\D/g, '').length;

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
  if (q.type === 'responseId') {
    if (q.required && isEmpty) {
      return inferResponseIdPrefixQuestionId(q)
        ? 'Answer the linked question so the Auto Serial can be assigned.'
        : 'Auto Serial is still being assigned.';
    }
    return null;
  }
  if (q.required && isEmpty) return 'This field is required';

  if (q.type === 'select' || q.type === 'radio') {
    if (isOtherSpecifyAnswer(value)) {
      if (isOtherChoiceUnavailable(q, answers)) {
        return 'Other is not available given your other answers. Please choose again.';
      }
      if (q.otherRequired && !value.text.trim()) {
        return 'Please specify the Other value.';
      }
    } else if (typeof value === 'string' && value) {
      const opts = ensureOptionShape(q.options);
      const opt = opts.find((o) => o.value === value);
      if (opt && isChoiceOptionUnavailable(opt, answers)) {
        return 'This option is not available given your other answers. Please choose again.';
      }
    }
  }
  if (q.type === 'multiselect' || q.type === 'checkbox') {
    const arr = Array.isArray(value) ? (value as string[]) : [];
    const opts = ensureOptionShape(q.options);
    for (const s of arr) {
      const opt = opts.find((o) => o.value === s);
      if (opt && isChoiceOptionUnavailable(opt, answers)) {
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
      const num = parseLocaleNumber(String(value));
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
  if (
    /failed to fetch/i.test(raw) ||
    /networkerror/i.test(raw) ||
    /network request failed/i.test(raw) ||
    /load failed/i.test(raw)
  ) {
    return 'You appear to be offline. Your work is saved on this device and will sync when you reconnect.';
  }
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
  forceNew = false,
  geofenceZones = [],
  strictGeofence = false,
  geofenceBufferMeters = ASSIGNED_ZONE_BUFFER_METERS,
  linkedFeature,
}) => {
  const { user, userProfile } = useAuth();
  const { location: deviceLocation, requestLocation } = useGeoLocation();
  const projectId = projectIdProp || questionnaire.projectId || DEFAULT_PROJECT_ID;
  const isFullscreen = variant === 'fullscreen';
  const geofenceActive = strictGeofence && !readOnly && geofenceZones.length > 0;

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
    () => ({ ...linkedAttributeAnswers(questionnaire, linkedFeature?.attributes, linkedFeature?.surveyLayerKey), ...(existingResponse?.responses || {}) })
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
      durationSeconds: s.durationSeconds ?? 0,
      capturedAt:
        typeof s.capturedAt === 'string'
          ? s.capturedAt
          : s.capturedAt
            ? new Date(s.capturedAt as string).toISOString()
            : undefined
    };
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [enumeratorErrors, setEnumeratorErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'submitting'>('idle');
  const [surveyLanguage, setSurveyLanguage] = useState<SurveyLanguage>('en');
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
  const consentGate = questionnaire.consentGate || {
    enabled: true,
    title: 'Permission Grant',
    text: 'Before starting this survey, the enumerator must obtain verbal consent from the respondent. Please explain the purpose of the survey, that participation is voluntary, that the respondent may decline or stop at any time, and that their responses will be kept confidential and used only for the stated research purposes.',
    checkboxLabel: 'I confirm that I have obtained verbal consent from the respondent to conduct this survey.',
    substituteEnumeratorName: true,
  };
  const linkedFeatureAttributes = useMemo(() => {
    const attributes = linkedFeature?.attributes || {};
    const embeddedFields = new Set((questionnaire.questions || [])
      .filter((question) => question.featureAttributeLink && linkedFeature?.surveyLayerKey && question.featureAttributeLink.layerKey.trim().normalize('NFKC').toLocaleLowerCase() === linkedFeature.surveyLayerKey.trim().normalize('NFKC').toLocaleLowerCase())
      .map((question) => question.featureAttributeLink!.field));
    return Object.fromEntries(Object.entries(attributes).filter(([field]) => !embeddedFields.has(field)));
  }, [questionnaire.questions, linkedFeature?.attributes, linkedFeature?.surveyLayerKey]);
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

  // Drop accidental plain Response ID duplicates (same key, no logic).
  const surveyQuestions = useMemo(
    () => normalizeQuestionnaireSectionQuestions(
      collapseAccidentalResponseIdQuestions(questionnaire.questions || []),
      questionnaire.sections || []
    ),
    [questionnaire.questions, questionnaire.sections]
  );
  const numbering = useMemo(
    () => buildQuestionNumbering(surveyQuestions),
    [surveyQuestions]
  );

  // Visible questions respect display logic AND the consent gate.
  const visibleQuestions = useMemo(() => {
    const all = surveyQuestions;
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
  }, [surveyQuestions, responses]);

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
    for (const q of surveyQuestions) {
      if (q.type === 'responseId') ids.add(q.id);
    }
    return ids;
  }, [appliedDefaultRules, slumAutoFieldIds, surveyQuestions]);

  const responseIdFieldIds = useMemo(
    () => surveyQuestions.filter((q) => q.type === 'responseId').map((q) => q.id),
    [surveyQuestions]
  );

  const responsesRef = useRef(responses);
  responsesRef.current = responses;

  /** Prefer a currently-visible Response ID (logic branch), else first. */
  const primaryResponseIdQuestion = useMemo(() => {
    const ridQuestions = surveyQuestions.filter((q) => q.type === 'responseId');
    if (ridQuestions.length === 0) return null;
    const visibleRid = visibleQuestions.find((q) => q.type === 'responseId');
    return visibleRid || ridQuestions[0];
  }, [surveyQuestions, visibleQuestions]);

  /** Changes when the resolved type-prefix changes (e.g. একক → বৃক্ষগুচ্ছ). */
  const responseIdPrefixKey = useMemo(() => {
    if (!primaryResponseIdQuestion) return '';
    const prefix = resolveResponseIdPrefix(
      primaryResponseIdQuestion,
      responses,
      surveyQuestions
    );
    if (prefix === null) return '__waiting__';
    if (prefix === '') return '__plain__';
    return prefix;
  }, [primaryResponseIdQuestion, responses, surveyQuestions]);

  // Allocate Response ID: plain serial, or `{prefix}-{serial}` when linked
  // via config / display logic. Locked; shared across all responseId fields.
  useEffect(() => {
    if (readOnly || !user?.uid || responseIdFieldIds.length === 0) return;
    if (!primaryResponseIdQuestion) return;

    const liveAnswers = responsesRef.current;
    const prefix = resolveResponseIdPrefix(
      primaryResponseIdQuestion,
      liveAnswers,
      surveyQuestions
    );
    if (prefix === null) {
      setResponses((prev) => {
        let dirty = false;
        const next = { ...prev };
        for (const id of responseIdFieldIds) {
          if (next[id] !== undefined && next[id] !== '') {
            delete next[id];
            dirty = true;
          }
        }
        return dirty ? next : prev;
      });
      return;
    }

    const current = responseIdFieldIds
      .map((id) => liveAnswers[id])
      .find((v) => v != null && v !== '');

    if (existingResponse && current && String(current).trim()) {
      const shared = String(current).trim();
      // Keep saved value unless prefix bucket changed (e.g. area switched).
      if (responseIdMatchesPrefix(shared, prefix)) {
        setResponses((prev) => mergeResponseIdIntoAnswers(shared, responseIdFieldIds, prev));
        return;
      }
    }

    if (current && responseIdMatchesPrefix(current, prefix)) {
      const shared = String(current).trim();
      setResponses((prev) => mergeResponseIdIntoAnswers(shared, responseIdFieldIds, prev));
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const nextId = await allocateNextResponseId({
          questionnaireId: questionnaire.id,
          respondentId: user.uid,
          prefix,
          responseIdFieldIds,
          excludeResponseId: draftDocIdRef.current || existingResponse?.id
        });
        if (cancelled) return;
        setResponses((prev) => mergeResponseIdIntoAnswers(nextId, responseIdFieldIds, prev));
      } catch (e) {
        console.warn('QuestionnaireForm: response id allocation failed', e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    readOnly,
    user?.uid,
    responseIdFieldIds,
    questionnaire.id,
    existingResponse,
    primaryResponseIdQuestion,
    surveyQuestions,
    responseIdPrefixKey
  ]);

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

  const resolveGeofencePoint = (): { lat: number; lng: number } | null => {
    if (submissionGps) return { lat: submissionGps.lat, lng: submissionGps.lng };
    if (currentLocation?.lat != null && currentLocation?.lng != null) {
      return { lat: currentLocation.lat, lng: currentLocation.lng };
    }
    if (deviceLocation?.lat != null && deviceLocation?.lng != null) {
      return { lat: deviceLocation.lat, lng: deviceLocation.lng };
    }
    return null;
  };

  const checkGeofence = ():
    | { ok: true; zone: ZonePolygon | null }
    | { ok: false; message: string } => {
    if (!geofenceActive) return { ok: true, zone: null };
    const pt = resolveGeofencePoint();
    if (!pt) {
      return {
        ok: false,
        message:
          `Strict geofence is on. Capture GPS inside your assigned zone or within ${geofenceBufferMeters} m of its boundary before submitting.`,
      };
    }
    const proximity = findZoneWithinDistance(
      pt.lng,
      pt.lat,
      geofenceZones,
      geofenceBufferMeters
    );
    if (!proximity) {
      return {
        ok: false,
        message:
          `You are more than ${geofenceBufferMeters} m outside your assigned zone. Move closer to the assigned area and recapture GPS to submit.`,
      };
    }
    return { ok: true, zone: proximity.zone };
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
    const geofenceOk = !geofenceActive || checkGeofence().ok;

    return (
      Object.keys(newQ).length === 0 &&
      Object.keys(newE).length === 0 &&
      consentOk &&
      gpsOk &&
      geofenceOk
    );
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
      projectId,
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
        // Prefer the moment GPS was locked — not the later Submit click.
        capturedAt: submissionGps.capturedAt || new Date().toISOString()
      });
    }
    if (geofenceActive) {
      const gate = checkGeofence();
      if (gate.ok && gate.zone) {
        base.zoneId = gate.zone.id;
        base.zoneAssignValue = gate.zone.assignValue || undefined;
      }
    }
    if (status === 'submitted') {
      // Keep the original submit time if this response was already submitted
      // (e.g. admin re-save); otherwise stamp now.
      const prevSubmitted = existingResponse?.submittedAt;
      base.submittedAt =
        prevSubmitted && existingResponse?.status === 'submitted'
          ? prevSubmitted
          : new Date().toISOString();
    }
    const resolvedFeatureId = linkedFeature?.id || existingResponse?.linkedFeatureId;
    if (resolvedFeatureId) {
      base.linkedFeatureId = resolvedFeatureId;
      if (linkedFeature?.attributes) {
        base.linkedFeatureProperties = linkedFeature.attributes;
      } else if (existingResponse?.linkedFeatureProperties) {
        base.linkedFeatureProperties = existingResponse.linkedFeatureProperties;
      }
    }
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

  const applyResponseIdBeforeSave = async (
    data: Omit<QuestionnaireResponse, 'id'>,
    excludeResponseId?: string
  ): Promise<Omit<QuestionnaireResponse, 'id'>> => {
    if (!user?.uid || responseIdFieldIds.length === 0) return data;
    const ridPrimary = primaryResponseIdQuestion;
    if (!ridPrimary) return data;
    const answers = data.responses || {};
    const prefix = resolveResponseIdPrefix(ridPrimary, answers, surveyQuestions);
    if (prefix === null) return data;

    const existing = responseIdFieldIds.map((id) => answers[id]).find((v) => v != null && v !== '');
    if (existing && responseIdMatchesPrefix(existing, prefix)) {
      const shared = String(existing).trim();
      return {
        ...data,
        responses: mergeResponseIdIntoAnswers(shared, responseIdFieldIds, answers)
      };
    }
    if (existing && isAllocatedResponseIdValue(existing) && prefix === '') {
      return {
        ...data,
        responses: mergeResponseIdIntoAnswers(
          String(existing).trim(),
          responseIdFieldIds,
          answers
        )
      };
    }

    try {
      const nextId = await allocateNextResponseId({
        questionnaireId: questionnaire.id,
        respondentId: user.uid,
        prefix,
        responseIdFieldIds,
        excludeResponseId
      });
      const merged = mergeResponseIdIntoAnswers(nextId, responseIdFieldIds, answers);
      setResponses(merged);
      return { ...data, responses: merged };
    } catch (e) {
      console.warn('QuestionnaireForm: response id allocation before save failed', e);
      return data;
    }
  };

  const persistResponse = async (status: 'draft' | 'submitted'): Promise<{ savedId: string; queued: boolean }> => {
    const existingId = draftDocIdRef.current;
    let responseData = buildResponseData(status);
    responseData = await applyDwellingIdBeforeSave(responseData, status, existingId);
    responseData = await applyResponseIdBeforeSave(responseData, existingId);
    const optimisticId = existingId || `resp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    if (!existingId) {
      rememberDraftDocId(optimisticId);
    }

    try {
      const saved = await geosurveyApi.saveResponse(
        existingId ? { ...responseData, id: existingId } : responseData
      );
      const savedId = String((saved as { id?: string }).id ?? optimisticId);
      const queued = Boolean(
        (saved as { status?: string; _offlinePending?: boolean }).status === 'queued' ||
        (saved as { _offlinePending?: boolean })._offlinePending === true
      );
      rememberDraftDocId(savedId);
      if (status === 'submitted' && draftStorageKey) {
        try {
          sessionStorage.removeItem(draftStorageKey);
        } catch {
          /* ignore */
        }
      }
      return { savedId, queued };
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
      invalidateResponseIdCache(questionnaire.id);
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
    if (geofenceActive && !resolveGeofencePoint()) {
      try {
        await requestLocation?.();
      } catch {
        /* ignore */
      }
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
      const gate = checkGeofence();
      if (geofenceActive && gate.ok === false) {
        setSubmitError(gate.message);
        return;
      }
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
      const { savedId, queued } = await persistResponse('submitted');
      invalidateDwellingIdCache(questionnaire.id);
      invalidateResponseIdCache(questionnaire.id);
      onSubmit?.({
        ...(responseData as any),
        id: savedId,
        status: queued ? 'queued' : 'submitted'
      } as QuestionnaireResponse);
      const offline = await isDeviceOffline();
      const pendingCount = countPendingResponses();
      alert(
        queued || offline
          ? `Submission queued for upload${pendingCount > 0 ? ` (${pendingCount} pending)` : ''}. It will upload automatically once you reconnect.`
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
        accuracyEnabled: submissionGpsConfig.accuracyEnabled,
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
              <span className="truncate">{getLocalizedText(questionnaire.title, surveyLanguage) || 'Untitled Questionnaire'}</span>
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
        <div className="flex items-center gap-2 shrink-0">
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] font-medium text-slate-700 shadow-sm">
            <span className="uppercase tracking-wide text-slate-500">Lang</span>
            <select
              aria-label="Survey language"
              value={surveyLanguage}
              onChange={(e) => setSurveyLanguage(e.target.value as SurveyLanguage)}
              className="bg-transparent text-slate-700 font-semibold outline-none"
            >
              <option value="en">ENG</option>
              <option value="bn">বাংলা</option>
            </select>
          </label>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:bg-white/60 rounded-lg shrink-0"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>
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

      {/* Linked Geospatial Feature banner */}
      {(linkedFeature || existingResponse?.linkedFeatureId) && (
        <div className="px-5 py-2 bg-indigo-50/80 border-b border-indigo-100 text-[11px] text-indigo-900 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-1.5 truncate">
            <FileText size={12} className="text-indigo-600 shrink-0" />
            <span className="font-semibold">Linked Feature:</span>
            <span className="font-mono text-[10px] text-indigo-700">
              #{String(linkedFeature?.id || existingResponse?.linkedFeatureId).slice(0, 12)}
            </span>
            {linkedFeature?.attributes?.name && (
              <span className="text-indigo-800">· {linkedFeature.attributes.name}</span>
            )}
          </div>
          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-indigo-100 text-indigo-700">
            Geospatial Linked
          </span>
        </div>
      )}

      {geofenceActive && (
        <div className="px-5 py-2 bg-sky-50/80 border-b border-sky-100 text-[11px] text-sky-900 flex items-start gap-1.5 shrink-0">
          <MapPin size={12} className="mt-0.5 shrink-0" />
          <span>
            Strict geofence: submit inside your assigned zone or within {geofenceBufferMeters} m
            outside its boundary
            {geofenceZones.length === 1 && geofenceZones[0].assignValue
              ? ` (${geofenceZones[0].assignValue})`
              : ` (${geofenceZones.length} zone${geofenceZones.length === 1 ? '' : 's'})`}
            .
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
            <DescriptionRenderer blocks={descriptionBlocks} language={surveyLanguage} />
          </div>
        ) : questionnaire.description ? (
          <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap border-b border-slate-100 pb-4">
            {getLocalizedText(questionnaire.description, surveyLanguage)}
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
              language={surveyLanguage}
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
            language={surveyLanguage}
          />
        )}

        {questionsUnlocked && Object.keys(linkedFeatureAttributes).length > 0 && (
          <section className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-4 space-y-3">
            <div>
              <h3 className="text-sm font-bold text-indigo-950">Linked feature information</h3>
              <p className="mt-0.5 text-[11px] text-indigo-700">Selected layer attributes are attached to this questionnaire response.</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {Object.entries(linkedFeatureAttributes).map(([field, value], index) => (
                <div key={field} className="rounded-lg border border-indigo-100 bg-white px-3 py-2.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{index + 1}. {field}</p>
                  <p className="mt-1 text-sm font-medium text-slate-900 break-words">{value == null || value === '' ? '—' : String(value)}</p>
                </div>
              ))}
            </div>
          </section>
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
            {/* Show stable section.question numbering; logic-gated questions
                receive nested letters beneath their controlling question. */}
            {(() => {
              const slots = buildVisibleQuestionSlots(visibleQuestions, numbering);
              return slots.map(({ question: q, label, depth }) => {
                const link = q.featureAttributeLink;
                const linkedLayerMatches = Boolean(
                  link &&
                  linkedFeature?.surveyLayerKey &&
                  link.layerKey.trim().normalize('NFKC').toLocaleLowerCase() ===
                    linkedFeature.surveyLayerKey.trim().normalize('NFKC').toLocaleLowerCase()
                );
                const linkedValue = link && linkedLayerMatches
                  ? linkedFeature?.attributes?.[link.field]
                  : undefined;
                const linkedQuestionLocked = Boolean(
                  link &&
                  linkedLayerMatches &&
                  linkedValue !== undefined &&
                  linkedValue !== null &&
                  linkedValue !== '' &&
                  !isSurveyDateQuestion(q)
                );
                const locked = lockedQuestionIds.has(q.id) || linkedQuestionLocked;
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
                        numberLabel={label}
                        question={q}
                        value={responses[q.id]}
                        onChange={(v) => handleAnswer(q.id, v)}
                        allAnswers={answersForOptionLogic}
                        allQuestions={visibleQuestions}
                        preserveComputedValue={readOnly}
                        language={surveyLanguage}
                      />
                      {locked && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-1.5 py-0.5 mt-1">
                          {linkedQuestionLocked ? 'Auto-filled from map layer' : 'Auto-filled (locked by rule)'}
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
                    <DescriptionRenderer blocks={conclusionBlocks} language={surveyLanguage} />
                  ) : (
                    <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                      {getLocalizedText(questionnaire.conclusion, surveyLanguage)}
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
