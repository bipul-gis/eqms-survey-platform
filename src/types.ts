export type FeatureType = 'point' | 'line' | 'polygon';
export type FeatureStatus = 'pending' | 'verified' | 'rejected';

export interface GeoFeature {
  id: string;
  type: FeatureType;
  geometry: any; // GeoJSON geometry
  /** Landmark fields + `__source`, `__taskWard` (immutable task ward from import; enumerator scope). Editable `Ward_Name` can differ for reporting/SHP. */
  attributes: Record<string, any>;
  status: FeatureStatus;
  remarks?: string;
  /** Auto-generated backend note for point move operations. */
  moveRemarks?: string;
  /** Auto-generated backend note when a new feature is created. */
  newFeatureRemarks?: string;
  /** Newline-separated audit log of admin-profile actions (import, merge, QC, moves). */
  adminRM?: string;
  createdBy: string;
  createdByUid?: string;
  /** Approved enumerator email only; never an admin account (`ccc_landmark_import` when unset / system). */
  updatedBy: string;
  updatedAt: string;
  /** Set when status becomes `verified` (verification time — not upload/merge time). */
  verifiedAt?: unknown;
  /** Email of user who verified (paired with `verifiedAt`). */
  verifiedBy?: string;
  collectorLocation?: {
    lat: number;
    lng: number;
    accuracy?: number;
  };
}

export interface WardBoundary {
  id: string;
  name: string;
  geometry: any;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  mobileNumber?: string;
  role: 'enumerator' | 'admin';
  status: 'pending' | 'approved' | 'rejected';
  /** Map UI preference: landmark circle marker scale (client-clamped roughly 0.6–2.4). */
  landmarkIconScale?: number;
  /**
   * @deprecated Use `assignedWardNames`. Kept for older user docs.
   */
  assignedWardName?: string | null;
  /**
   * Admin-assigned ward(s) for tasking: feature `Ward_Name` / `WARDNAME` must match one of these
   * (same strings as ward boundary `WARDNAME`, e.g. Ward 01).
   */
  assignedWardNames?: string[];
  /**
   * Per-project ward assignments — `{ [projectId]: ['Ward 01', 'Ward 02', …] }`.
   * Wards are stored at the project scope so an enumerator can hold different
   * wards in different projects. The legacy `assignedWardNames` field above
   * remains the project-agnostic geospatial filter consumed by the map view;
   * the admin UI mirrors this per-project map into the global union so the
   * existing map filter keeps working without changes.
   */
  projectWardAssignments?: { [projectId: string]: string[] };
  /**
   * IDs of questionnaires this enumerator is allowed to fill. Used in
   * combination with the questionnaire's `projectId` to filter what they see
   * for each project. Empty/undefined means "no questionnaires assigned".
   */
  assignedQuestionnaireIds?: string[];
  /**
   * Slum IDs (`SLUMID` from slum reference CSV) this enumerator may survey
   * in questionnaire tasks. Union across projects when mirrored from
   * `projectSlumAssignments`.
   */
  assignedSlumIds?: string[];
  /**
   * Per-project slum tasking — `{ [projectId]: ['20151612364', …] }`.
   */
  projectSlumAssignments?: { [projectId: string]: string[] };
}

/**
 * A high-level container that groups Geospatial + Questionnaire work for a
 * single engagement. Admin selects a project on login, and all subsequent
 * tooling (map data, questionnaires, user assignments) is scoped to it.
 */
export interface Project {
  id: string;
  /** Human-readable project name. */
  name: string;
  /** Short admin code / reference number (e.g. internal contract code). */
  code: string;
  /** Optional longer description shown on the project card. */
  description?: string;
  /**
   * Which survey segments are enabled for this project. Both default to true
   * so a project can host geospatial wards + questionnaires together; an
   * admin can disable a segment to make a project single-purpose.
   */
  segments?: {
    geospatial?: boolean;
    questionnaire?: boolean;
  };
  /** Soft-archive flag. Archived projects are hidden by default. */
  isActive?: boolean;
  createdAt?: unknown;
  createdBy?: string;
  updatedAt?: unknown;
}

export type QuestionType =
  | 'text'
  | 'longtext'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'radio'
  | 'checkbox'
  | 'date'
  | 'time'
  | 'datetime'
  | 'email'
  | 'phone'
  | 'age'
  | 'rating'
  | 'scale'
  | 'location'
  | 'photo'
  | 'signature'
  | 'matrix'
  | 'computed'
  | 'responseId'
  | 'section';

/**
 * Operation used by a `computed` question. The enumerator never types
 * the answer — it's derived live from other questions' answers.
 *
 * - `sum` / `subtract` / `multiply` / `divide`: arithmetic over the
 *   operands in the order they appear in `operandQuestionIds`.
 * - `average`: arithmetic mean of all non-empty numeric operands.
 * - `min` / `max`: extreme of all non-empty numeric operands.
 * - `count_nonempty`: integer count of operands that have any answer
 *   (handy for "how many household members are employed" totals).
 * - `concat`: string concatenation of operand answers, joined by the
 *   configured separator (defaults to a single space).
 * - `expression`: free arithmetic expression with `{{questionId}}`
 *   placeholders — only `+ - * / ( )` and numeric literals allowed.
 */
export type ComputedOperation =
  | 'sum'
  | 'subtract'
  | 'multiply'
  | 'divide'
  | 'average'
  | 'min'
  | 'max'
  | 'count_nonempty'
  | 'concat'
  | 'expression';

export interface ComputedSpec {
  operation: ComputedOperation;
  /**
   * Question ids whose answers feed the formula. Order matters for
   * `subtract`, `divide` and `concat`. For `expression` they're only
   * advisory (the placeholders inside `expression` are the source of
   * truth) but we still keep them so the dependency tracker can rebuild
   * the computed value as those answers change.
   */
  operandQuestionIds: string[];
  /**
   * Free-form arithmetic expression for `operation === 'expression'`.
   * Use `{{questionId}}` or `{{questionKey}}` placeholders. Only `+`,
   * `-`, `*`, `/`, parentheses and numeric literals are evaluated;
   * anything else is rejected and the result falls back to empty.
   */
  expression?: string;
  /** Number of decimal places to round to (defaults to 2 for arithmetic, no rounding for `count_nonempty`). */
  decimals?: number;
  /** Optional prefix shown before the value (e.g. "BDT "). */
  prefix?: string;
  /** Optional suffix shown after the value (e.g. " m²" or "%"). */
  suffix?: string;
  /** For `concat` only. Joiner between operand strings (defaults to a single space). */
  separator?: string;
}

/**
 * Auto Serial / Case ID question.
 * - No linked / no display logic → plain serial `1`, `2`, `3`…
 * - Display logic or explicit prefix question → `{optionLabel}_{serial}`
 *   e.g. একক গাছ → `একক_১`, বৃক্ষগুচ্ছ (ক্যানোপি) → `বৃক্ষগুচ্ছ_১`
 * Unique per enumerator × questionnaire × prefix. Locked for enumerators.
 */
export interface ResponseIdConfig {
  /**
   * Optional question whose answer becomes the ID prefix.
   * When omitted, the first question referenced by this field's display
   * logic is used automatically (universal for option-based show/hide).
   */
  prefixQuestionId?: string;
}

/**
 * Stored shape of an `age` answer. Both fields are integers; we keep them
 * structured (rather than serialising "3 years 5 months") so admins can
 * sort/filter on years separately and the CSV export can break them into
 * two columns if needed. `totalMonths` is derived but persisted for fast
 * queries.
 */
export interface AgeValue {
  /** May be a number or a digit string (Latin or Bangla) as typed. */
  years: number | string;
  months: number | string;
  /** Convenience field: years * 12 + months (always numeric). */
  totalMonths?: number;
}

/** Option for choice questions. `value` is the stored answer; `label` is shown to enumerators. */
export interface QuestionOption {
  id: string;
  value: string;
  label: string;
  /**
   * When set with `enabled` and at least one condition, this option cannot
   * be selected while the rule matches current answers (same evaluation as
   * question display logic). Example: disable option 4 when question 8a is
   * not zero — one condition: ref 8a, operator `notEquals`, value `0`.
   */
  disabledWhen?: LogicRule;
}

export interface QuestionValidation {
  /**
   * Numeric min (for number / rating / scale) or string min length (for text/longtext).
   * For `phone` questions, this is interpreted as the **minimum digit count**
   * (separator characters like space, hyphen, `+`, parens are stripped before
   * counting), so "min = 10" rejects an 8-digit number even if the admin
   * typed a longer formatted version like `+880 1712-345`.
   */
  min?: number;
  /** Numeric max (for number / rating / scale) or string max length (for text/longtext). For `phone`, max digit count — see `min`. */
  max?: number;
  /** Integer-only when type='number'. */
  integerOnly?: boolean;
  /** Decimal step for numeric inputs. */
  step?: number;
  /** Regex pattern (no slashes) — validated against the string value. */
  pattern?: string;
  /** Custom error message shown when validation fails. */
  errorMessage?: string;
  /** For date / datetime: earliest accepted (ISO `YYYY-MM-DD`). */
  minDate?: string;
  /** For date / datetime: latest accepted (ISO `YYYY-MM-DD`). */
  maxDate?: string;
  /** For multiselect / checkbox: minimum number of selections. */
  minSelections?: number;
  /** For multiselect / checkbox: maximum number of selections. */
  maxSelections?: number;
  /**
   * For `phone` questions: exact total digit count required (separator
   * characters are stripped before counting). When set, takes precedence
   * over `min`/`max`. E.g. `digits = 11` accepts `01712345678` and
   * `+880 1712-345678` but rejects 10-digit or 12-digit inputs.
   */
  digits?: number;
}

export type LogicOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'greaterThan'
  | 'lessThan'
  | 'isEmpty'
  | 'isNotEmpty';

export interface LogicCondition {
  id: string;
  /** Reference question id whose answer drives the rule. */
  questionId: string;
  operator: LogicOperator;
  /** Comparison value (string for text/number; one of `options[].value` for choice). */
  value?: string;
}

export type LogicCombinator = 'AND' | 'OR';

export interface LogicRule {
  /** When true, the question is shown only if rules match. When false (default), question is always shown. */
  enabled: boolean;
  combinator: LogicCombinator;
  conditions: LogicCondition[];
}

/**
 * Behaviour of a `DefaultValueRule` when its `when` condition matches.
 *
 * - `fillIfEmpty`: set the target answer to the rule value only when the
 *   target is currently empty. Enumerators can still freely overwrite. Use
 *   for "smart pre-fill" UX (e.g. "if Has electricity = No → suggest 0
 *   hours/day, but enumerator can still type a different number").
 * - `lock`: keep the target answer equal to the rule value and disable the
 *   input so enumerators cannot edit it. Use when the answer is fully
 *   implied by another (e.g. "if Tenure = Owned → Rent paid is 0, locked").
 *   When the condition stops matching, the lock releases and the value is
 *   left where it was (enumerators can edit again).
 */
export type ValueRuleMode = 'fillIfEmpty' | 'lock';

/**
 * Conditional auto-fill / lock rule for a single question. Lives ON the
 * target question — the question whose value gets set. The `when` rule's
 * conditions reference OTHER questions to decide whether the rule fires.
 */
export interface DefaultValueRule {
  id: string;
  /** Rule fires while this condition matches (must be `enabled` with at least one condition). */
  when: LogicRule;
  /** Value to apply to the target question. Stored as string, coerced at runtime to the target's type. */
  value: string;
  mode: ValueRuleMode;
}

export interface Question {
  id: string;
  type: QuestionType;
  /** The question prompt shown to the respondent. */
  question: string;
  /** Internal short key used as the response field id (e.g. `head_name`). Falls back to `id`. */
  key?: string;
  /** Help / description text rendered below the question prompt. */
  description?: string;
  required: boolean;
  /**
   * Plain string options (legacy) OR rich `QuestionOption[]`. The builder
   * always writes `QuestionOption[]`; legacy data is migrated on load.
   */
  options?: string[] | QuestionOption[];
  /** Allow "Other / specify" free-text option on choice questions. */
  allowOther?: boolean;
  placeholder?: string;
  /** Default pre-filled value (string, number, or array depending on type). */
  defaultValue?: unknown;
  validation?: QuestionValidation;
  /** Display logic — show this question only when rules match. */
  logic?: LogicRule;
  /**
   * Conditional default-value rules — auto-fill or lock this question's
   * answer based on answers to other questions. Rules are evaluated in
   * order; the first one whose `when` matches wins (so admins can layer
   * fallbacks). Empty/undefined means no auto behaviour.
   */
  defaultValueRules?: DefaultValueRule[];
  /**
   * Formula spec for `type === 'computed'`. The answer is auto-derived
   * live from other questions' answers and displayed read-only in the
   * runtime — enumerators never type it directly. See `ComputedSpec`.
   */
  computed?: ComputedSpec;
  /**
   * Config for `type === 'responseId'`. Auto serial per enumerator ×
   * questionnaire (and optional prefix from a linked question). Locked
   * for enumerators — assigned on first save / when the prefix is ready.
   */
  responseIdConfig?: ResponseIdConfig;
  /**
   * Parent question id when this question is a **sub-question** (e.g.
   * 1.a, 1.b under question 1). Single-level nesting only — a
   * sub-question can't itself have sub-questions. When the parent is
   * hidden by its `logic` rule, every child is hidden alongside it.
   */
  parentId?: string;
  /** For matrix questions only — row labels. */
  rows?: string[];
  /** For matrix questions only — column option labels. */
  columns?: string[];
  /** For section dividers: heading is `question`, body is `description`; no input. */
  /** Optional grouping — questions sharing the same `sectionId` belong to a section. */
  sectionId?: string;
  /**
   * GPS capture tuning for `location`-type questions. Lets each location
   * question configure its own accuracy threshold, stabilization window, and
   * whether a capture is required (independent of `Question.required`, but
   * `required` implies a successful capture as well).
   */
  gpsSettings?: GpsCaptureSettings;
}

export interface QuestionnaireSection {
  id: string;
  title: string;
  description?: string;
  /** Display logic for the whole section. */
  logic?: LogicRule;
}

/**
 * Rich-text "description" content. The questionnaire description is no longer
 * a single string — admins can compose a small document made of headings,
 * paragraphs, and tables. Plain string `description` is kept on the
 * `Questionnaire` for backward compatibility and as a flattened summary.
 */
export type DescriptionBlock =
  | { id: string; type: 'heading'; level: 1 | 2 | 3; text: string }
  | { id: string; type: 'paragraph'; text: string }
  | { id: string; type: 'table'; rows: string[][] };

/**
 * Structured "enumerator info" captured at the very top of the questionnaire
 * before the actual questions. Rendered as a two-column table on the
 * respondent's side. Each field reuses the same `Question` shape so admins
 * can configure it just like a regular question (type, required, options,
 * validation).
 */
export interface EnumeratorInfo {
  enabled: boolean;
  title: string;
  description?: string;
  fields: Question[];
}

/**
 * Consent / permission gate rendered between the enumerator info and the
 * actual survey questions. The questions are hidden until the enumerator
 * confirms (via checkbox) that they have obtained verbal consent from the
 * respondent.
 */
export interface ConsentGate {
  enabled: boolean;
  title: string;
  /** The consent / permission paragraph shown to the enumerator. */
  text: string;
  /** Label shown next to the checkbox. */
  checkboxLabel: string;
  /**
   * When true (default), `{{enumeratorName}}` (and `{{enumerator_name}}`)
   * in `text` and `checkboxLabel` is replaced with the signed-in
   * enumerator's name when the form is shown.
   */
  substituteEnumeratorName?: boolean;
}

/**
 * Tunable GPS capture parameters reused for both the end-of-survey submission
 * GPS and per-question `location`-type questions.
 */
export interface GpsCaptureSettings {
  /**
   * When `false`, accuracy is not gated — capture locks after the
   * stabilization delay once any sample is received. Defaults to `true`.
   */
  accuracyEnabled?: boolean;
  /** Required GPS accuracy threshold in meters (e.g. 10 m). Ignored when accuracyEnabled is false. */
  accuracyMeters: number;
  /** Minimum continuous watch duration before locking in a sample, in seconds. */
  stabilizationSeconds: number;
  /** When true, the user must successfully capture before continuing/submitting. */
  required: boolean;
  /** Start the watcher automatically as soon as the widget is mounted. */
  autoStart?: boolean;
  /**
   * If true, allow the user to manually "Use anyway" once stabilization elapses
   * even if the accuracy gate has not been met. Defaults to false (strict).
   */
  allowManualOverride?: boolean;
}

/**
 * End-of-survey GPS capture configuration. When enabled, after the last
 * question the enumerator's device captures their location for a minimum
 * stabilization window (to avoid noisy initial fixes) and only accepts the
 * sample once accuracy is at or below the configured threshold.
 */
export interface SubmissionGpsCapture extends GpsCaptureSettings {
  enabled: boolean;
  title: string;
  description: string;
}

export interface QuestionnaireSettings {
  /** Show a progress bar to respondents. */
  showProgress?: boolean;
  /** Allow respondents to save and return to a draft. */
  allowSaveDraft?: boolean;
  /** Render one section per page (true) or a single scrolling page (false). */
  paginated?: boolean;
  /** Auto-attach respondent location when submitting. */
  captureLocation?: boolean;
  /** Randomize question order within each section. */
  shuffleQuestions?: boolean;
}

export interface Questionnaire {
  id: string;
  /**
   * Owning project. New questionnaires authored via the admin UI are always
   * stamped with the current project. Legacy docs without `projectId` are
   * treated as belonging to the default project at read time.
   */
  projectId?: string;
  title: string;
  /** Plain-text fallback / summary derived from `descriptionBlocks` when present. */
  description: string;
  /** Rich-content description: headings, paragraphs, tables. Authoritative when set. */
  descriptionBlocks?: DescriptionBlock[];
  /**
   * Plain-text summary of the conclusion (for search / list cards). Derived
   * from `conclusionBlocks` when the admin authors rich content.
   */
  conclusion?: string;
  /**
   * Closing content shown after the last survey question (and before
   * end-of-survey submission GPS when enabled): thank-you text, next steps,
   * contact info, etc. Same block types as `descriptionBlocks`.
   */
  conclusionBlocks?: DescriptionBlock[];
  /** Enumerator info captured above the survey questions, as a table form. */
  enumeratorInfo?: EnumeratorInfo;
  /** Permission/consent gate shown before survey questions. */
  consentGate?: ConsentGate;
  /** End-of-survey GPS capture (stabilization window + accuracy threshold). */
  submissionGps?: SubmissionGpsCapture;
  version: string;
  questions: Question[];
  /** Optional sections — when empty, all questions are rendered in order. */
  sections?: QuestionnaireSection[];
  settings?: QuestionnaireSettings;
  isActive: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionnaireResponse {
  id: string;
  questionnaireId: string;
  respondentId: string;
  respondentName: string;
  /** Email of the enumerator who submitted this response, when available. */
  respondentEmail?: string;
  location?: {
    lat: number;
    lng: number;
    ward?: string;
  };
  responses: Record<string, any>; // questionId -> answer
  /** Answers for the questionnaire's `enumeratorInfo.fields`, keyed by field id. */
  enumeratorInfo?: Record<string, any>;
  /** Whether the enumerator ticked the consent / permission-grant checkbox. */
  consentGranted?: boolean;
  /** Server timestamp captured when the consent checkbox was ticked. */
  consentGrantedAt?: unknown;
  /**
   * End-of-survey GPS capture result, when `submissionGps.enabled` was true at
   * submission time. `accuracy` is in meters; `capturedAt` is a Firestore
   * timestamp (server- or client-stamped).
   */
  submissionLocation?: {
    lat: number;
    lng: number;
    accuracy: number;
    capturedAt?: unknown;
    /** Total seconds spent watching to reach the threshold. */
    durationSeconds?: number;
  };
  status: 'draft' | 'submitted' | 'reviewed';
  submittedAt?: unknown;
  /**
   * Server-stamped on every write (draft save or submit). Lets the
   * enumerator UI surface "Saved N minutes ago" on drafts and gives admins
   * a stable last-touched ordering even before submission.
   */
  updatedAt?: unknown;
  reviewedBy?: string;
  reviewedAt?: unknown;
  notes?: string;
}
