import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from './AuthProvider';
import { AppFooter } from './AppFooter';
import { ChoiceWithOtherFields } from './ChoiceWithOtherFields';
import {
  ComputedOperation,
  ComputedSpec,
  ConsentGate,
  DefaultValueRule,
  DescriptionBlock,
  EnumeratorInfo,
  GpsCaptureSettings,
  LogicCondition,
  LogicOperator,
  LogicRule,
  Project,
  Question,
  QuestionOption,
  QuestionType,
  QuestionValidation,
  Questionnaire,
  QuestionnaireSection,
  QuestionnaireSettings,
  SubmissionGpsCapture,
  ValueRuleMode
} from '../types';
import { evaluateComputed } from '../lib/computedAnswers';
import { matrixAllRowsAnswered } from '../lib/matrixAnswers';
import { isChoiceOptionDisabled, ConsentGateForm, PhotoCaptureWidget } from './QuestionnaireRuntime';
import {
  choiceAnswerIsEmpty as choiceAnswerIsLogicallyEmpty,
  choiceAnswerToComparableString
} from '../lib/choiceAnswers';
import { DEFAULT_PROJECT_ID, listProjects, searchMisProjects } from '../lib/projects';
import { formatConsentGateTemplate } from '../lib/consentGateTemplate';
import { enumeratorResolvedDisplayName } from '../lib/userDisplayName';
import {
  FileText,
  Plus,
  Edit3,
  Trash2,
  Eye,
  X,
  Save,
  AlertCircle,
  CheckCircle,
  Copy,
  FolderInput,
  ArrowUp,
  ArrowDown,
  Layers,
  Settings,
  Filter,
  Calendar,
  Clock,
  Phone,
  Mail,
  Star,
  Sliders,
  MapPin,
  Camera,
  PenTool,
  Grid3x3,
  Hash,
  Type,
  AlignLeft,
  List as ListIcon,
  CheckSquare,
  CircleDot,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Search,
  Power,
  Heading as HeadingIcon,
  Table as TableIcon,
  Pilcrow,
  RowsIcon,
  Columns3 as ColumnsIcon,
  IdCard,
  ShieldCheck,
  Lock,
  Inbox,
  Locate,
  Satellite,
  Loader2,
  CheckCircle2,
  Crosshair,
  Sigma,
  CornerDownRight,
  CornerUpLeft
} from 'lucide-react';
import {
  handleFirestoreError,
  OperationType
} from '../lib/firebase';
import { geosurveyApi } from '../lib/geosurveyApi';

// Lazy: QuestionnaireResponsesView pulls in the CSV export helpers and a
// fairly large response table. Keep it out of the initial chunk so admins
// only pay the cost when they actually open the "Responses" view.
const QuestionnaireResponsesView = React.lazy(() =>
  import('./QuestionnaireResponsesView').then((m) => ({ default: m.QuestionnaireResponsesView }))
);

// ---------------------------------------------------------------------------
// Question type catalog (icon, label, default config) — drives the palette.
// ---------------------------------------------------------------------------

interface QuestionTypeDef {
  type: QuestionType;
  label: string;
  hint: string;
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  group: 'text' | 'choice' | 'datetime' | 'numeric' | 'media' | 'advanced';
  hasOptions?: boolean;
}

const QUESTION_TYPES: QuestionTypeDef[] = [
  { type: 'text',        label: 'Short Text',     hint: 'Single-line input',                 Icon: Type,        group: 'text' },
  { type: 'longtext',    label: 'Long Text',      hint: 'Multi-line paragraph',              Icon: AlignLeft,   group: 'text' },
  { type: 'email',       label: 'Email',          hint: 'Email-formatted text',              Icon: Mail,        group: 'text' },
  { type: 'phone',       label: 'Phone',          hint: 'Phone number',                      Icon: Phone,       group: 'text' },
  { type: 'number',      label: 'Number',         hint: 'Numeric input',                     Icon: Hash,        group: 'numeric' },
  { type: 'age',         label: 'Age',            hint: 'Years + months',                    Icon: Clock,       group: 'numeric' },
  { type: 'rating',      label: 'Star Rating',    hint: '1–5 stars',                         Icon: Star,        group: 'numeric' },
  { type: 'scale',       label: 'Linear Scale',   hint: 'Numeric range (e.g. 1–10)',         Icon: Sliders,     group: 'numeric' },
  { type: 'select',      label: 'Dropdown',       hint: 'Single choice — dropdown',          Icon: ChevronDown, group: 'choice', hasOptions: true },
  { type: 'radio',       label: 'Single Choice',  hint: 'Pick one (radio buttons)',          Icon: CircleDot,   group: 'choice', hasOptions: true },
  { type: 'multiselect', label: 'Multi Select',   hint: 'Pick many (dropdown)',              Icon: ListIcon,    group: 'choice', hasOptions: true },
  { type: 'checkbox',    label: 'Checkbox Group', hint: 'Pick many (checkboxes)',            Icon: CheckSquare, group: 'choice', hasOptions: true },
  { type: 'date',        label: 'Date',           hint: 'Calendar date',                     Icon: Calendar,    group: 'datetime' },
  { type: 'time',        label: 'Time',           hint: 'Time of day',                       Icon: Clock,       group: 'datetime' },
  { type: 'datetime',    label: 'Date & Time',    hint: 'Combined date and time',            Icon: Calendar,    group: 'datetime' },
  { type: 'location',    label: 'GPS Location',   hint: 'Auto-captured coordinates',         Icon: MapPin,      group: 'media' },
  { type: 'photo',       label: 'Photo',          hint: 'Camera capture',                    Icon: Camera,      group: 'media' },
  { type: 'signature',   label: 'Signature',      hint: 'Drawn signature',                   Icon: PenTool,     group: 'media' },
  { type: 'matrix',      label: 'Matrix / Grid',  hint: 'Rows × column options',             Icon: Grid3x3,     group: 'advanced' },
  { type: 'computed',    label: 'Computed',       hint: 'Auto-calculated from other answers',Icon: Sigma,       group: 'advanced' },
  { type: 'section',     label: 'Section Break',  hint: 'Group questions into a section',    Icon: Layers,      group: 'advanced' }
];

const QUESTION_TYPE_BY_KEY: Record<QuestionType, QuestionTypeDef> = QUESTION_TYPES.reduce(
  (acc, def) => ({ ...acc, [def.type]: def }),
  {} as Record<QuestionType, QuestionTypeDef>
);

const isChoiceType = (t: QuestionType) =>
  t === 'select' || t === 'multiselect' || t === 'radio' || t === 'checkbox';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const uid = (prefix = 'q') =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const slugify = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);

/** True for plain JSON-like objects; false for Date, Firestore FieldValue, Timestamp, etc. */
const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const p = Object.getPrototypeOf(value);
  return p === Object.prototype || p === null;
};

/**
 * Firestore rejects `undefined` anywhere in document data. React state often
 * carries explicit `undefined` optional fields — strip them recursively while
 * leaving Firestore sentinels and class instances untouched.
 */
const sanitizeForFirestore = (value: unknown): unknown => {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value
      .map(sanitizeForFirestore)
      .filter((v) => v !== undefined);
  }
  if (!isPlainRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const s = sanitizeForFirestore(v);
    if (s !== undefined) out[k] = s;
  }
  return out;
};

/**
 * Convert any Firestore-ish timestamp into milliseconds for sorting.
 * Tolerates ISO strings, numbers, JS Dates, Firestore `Timestamp` instances
 * (`toMillis()`), and the raw `{ seconds, nanoseconds }` shape that can appear
 * when serverTimestamp() is still pending. Returns 0 for unknown / nullish.
 */
const toMillis = (v: unknown): number => {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = new Date(v).getTime();
    return Number.isFinite(n) ? n : 0;
  }
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'object') {
    const anyV = v as { toMillis?: () => number; seconds?: number; nanoseconds?: number };
    if (typeof anyV.toMillis === 'function') {
      try {
        return anyV.toMillis();
      } catch {
        return 0;
      }
    }
    if (typeof anyV.seconds === 'number') {
      return anyV.seconds * 1000 + Math.floor((anyV.nanoseconds || 0) / 1e6);
    }
  }
  return 0;
};

const formatTimestamp = (v: unknown): string => {
  const ms = toMillis(v);
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '—';
  }
};

/** Flatten rich description blocks into a single line-broken plain-text summary. */
const blocksToPlainText = (blocks: DescriptionBlock[]): string => {
  return blocks
    .map((b) => {
      if (b.type === 'heading' || b.type === 'paragraph') return b.text.trim();
      if (b.type === 'table') {
        return b.rows
          .map((r) => r.map((c) => c.trim()).filter(Boolean).join(' | '))
          .filter(Boolean)
          .join('\n');
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
};

const ensureOptionShape = (options: Question['options']): QuestionOption[] => {
  if (!options || options.length === 0) return [];
  if (typeof options[0] === 'string') {
    return (options as string[]).map((s) => ({ id: uid('o'), value: s, label: s }));
  }
  return options as QuestionOption[];
};

const newDefaultQuestion = (type: QuestionType): Question => {
  const base: Question = {
    id: uid('q'),
    type,
    question: type === 'section' ? 'New Section' : 'Untitled Question',
    required: false,
    description: '',
    placeholder: '',
    validation: {}
  };
  if (isChoiceType(type)) {
    base.options = [
      { id: uid('o'), value: 'option_1', label: 'Option 1' },
      { id: uid('o'), value: 'option_2', label: 'Option 2' },
      { id: uid('o'), value: 'option_3', label: 'Option 3' }
    ];
  }
  if (type === 'rating') base.validation = { min: 1, max: 5 };
  if (type === 'scale') base.validation = { min: 1, max: 10, step: 1 };
  if (type === 'matrix') {
    base.rows = ['Row 1', 'Row 2', 'Row 3'];
    base.columns = ['Poor', 'Average', 'Good', 'Excellent'];
  }
  return base;
};

const blankLogic = (): LogicRule => ({
  enabled: false,
  combinator: 'AND',
  conditions: []
});

// ---------------------------------------------------------------------------
// Copy-from-project modal — clone a questionnaire into the current project
// ---------------------------------------------------------------------------

type SourceProjectOption = {
  id: string;
  name: string;
  code?: string;
  questionnaires: Questionnaire[];
};

const CopyFromProjectModal: React.FC<{
  currentProjectId?: string;
  currentProjectName?: string;
  onClose: () => void;
  onCopied: (created: Questionnaire) => void;
}> = ({ currentProjectId, currentProjectName, onClose, onCopied }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sources, setSources] = useState<SourceProjectOption[]>([]);
  const [sourceProjectId, setSourceProjectId] = useState('');
  const [selectedQuestionnaireId, setSelectedQuestionnaireId] = useState('');
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const [activeProjects, misProjects, qResult] = await Promise.all([
          listProjects().catch(() => [] as Project[]),
          searchMisProjects().catch(() => [] as Project[]),
          geosurveyApi.listQuestionnaires()
        ]);
        if (cancelled) return;

        const nameById = new Map<string, Project>();
        for (const p of [...misProjects, ...activeProjects]) {
          nameById.set(p.id, p);
        }

        const byProject = new Map<string, Questionnaire[]>();
        for (const raw of qResult.items as unknown as Questionnaire[]) {
          const pid = raw.projectId || DEFAULT_PROJECT_ID;
          if (currentProjectId && pid === currentProjectId) continue;
          const list = byProject.get(pid) || [];
          list.push(raw);
          byProject.set(pid, list);
        }

        const options: SourceProjectOption[] = [...byProject.entries()]
          .map(([id, questionnaires]) => {
            const meta = nameById.get(id);
            questionnaires.sort((a, b) => toMillis(b.updatedAt) - toMillis(a.updatedAt));
            return {
              id,
              name: meta?.name || id,
              code: meta?.code,
              questionnaires
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name));

        setSources(options);
        if (options.length > 0) {
          setSourceProjectId(options[0].id);
          setSelectedQuestionnaireId(options[0].questionnaires[0]?.id || '');
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load source questionnaires.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [currentProjectId]);

  const selectedSource = sources.find((s) => s.id === sourceProjectId) || null;
  const selectedQuestionnaire =
    selectedSource?.questionnaires.find((q) => q.id === selectedQuestionnaireId) || null;

  useEffect(() => {
    if (!selectedSource) {
      setSelectedQuestionnaireId('');
      return;
    }
    if (!selectedSource.questionnaires.some((q) => q.id === selectedQuestionnaireId)) {
      setSelectedQuestionnaireId(selectedSource.questionnaires[0]?.id || '');
    }
  }, [selectedSource, selectedQuestionnaireId]);

  const handleCopy = async () => {
    if (!selectedQuestionnaire || !currentProjectId) return;
    try {
      setCopying(true);
      setError(null);
      const { id: _omit, ...rest } = selectedQuestionnaire;
      void _omit;
      const now = new Date().toISOString();
      const dup = {
        ...rest,
        projectId: currentProjectId,
        title: `${selectedQuestionnaire.title} (Copy)`,
        isActive: false,
        createdAt: now,
        updatedAt: now
      };
      const ref = await geosurveyApi.saveQuestionnaire(dup as Record<string, unknown>);
      const created: Questionnaire = {
        ...(dup as Questionnaire),
        ...(ref as unknown as Questionnaire),
        id: String((ref as { id?: string }).id ?? ''),
        projectId: currentProjectId
      };
      onCopied(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to copy questionnaire.');
      handleFirestoreError(e, OperationType.CREATE, 'questionnaires');
    } finally {
      setCopying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4 bg-slate-900/40">
      <div
        className="absolute inset-0"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative w-full max-w-lg bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-slate-900">Copy from another project</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Clone a questionnaire into{' '}
              <span className="font-semibold text-slate-700">
                {currentProjectName || 'this project'}
              </span>
              . Responses are not copied.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-slate-500 py-8 justify-center">
              <Loader2 size={16} className="animate-spin" />
              Loading questionnaires…
            </div>
          ) : sources.length === 0 ? (
            <div className="text-center py-8 text-sm text-slate-500">
              <FolderInput size={32} className="mx-auto mb-2 text-slate-300" />
              No questionnaires found in other projects.
            </div>
          ) : (
            <>
              <label className="block">
                <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
                  Source project
                </span>
                <select
                  value={sourceProjectId}
                  onChange={(e) => setSourceProjectId(e.target.value)}
                  className="mt-1.5 w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                >
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.code ? ` (${s.code})` : ''} · {s.questionnaires.length} questionnaire
                      {s.questionnaires.length === 1 ? '' : 's'}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
                  Questionnaire
                </span>
                <select
                  value={selectedQuestionnaireId}
                  onChange={(e) => setSelectedQuestionnaireId(e.target.value)}
                  className="mt-1.5 w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                >
                  {(selectedSource?.questionnaires || []).map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.title}
                      {q.isActive ? '' : ' (Draft)'} · {q.questions?.length || 0} questions
                    </option>
                  ))}
                </select>
              </label>

              {selectedQuestionnaire && (
                <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 text-xs text-slate-600">
                  <p className="font-semibold text-slate-800">{selectedQuestionnaire.title}</p>
                  {selectedQuestionnaire.description && (
                    <p className="mt-0.5 line-clamp-2">{selectedQuestionnaire.description}</p>
                  )}
                  <p className="mt-1 text-slate-400">
                    v{selectedQuestionnaire.version || '1.0'} ·{' '}
                    {selectedQuestionnaire.questions?.length || 0} questions
                    {selectedQuestionnaire.sections?.length
                      ? ` · ${selectedQuestionnaire.sections.length} sections`
                      : ''}
                  </p>
                </div>
              )}
            </>
          )}

          {error && (
            <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/80 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-lg"
            disabled={copying}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleCopy()}
            disabled={
              copying || loading || !selectedQuestionnaire || !currentProjectId || sources.length === 0
            }
            className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg flex items-center gap-2"
          >
            {copying ? <Loader2 size={15} className="animate-spin" /> : <Copy size={15} />}
            {copying ? 'Copying…' : 'Copy into this project'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Top-level component — list view OR builder view
// ---------------------------------------------------------------------------

interface QuestionnaireManagerProps {
  /**
   * Active project. When set, the list is filtered to questionnaires belonging
   * to this project (including legacy docs without `projectId`, which fall
   * back to the canonical default project), and new questionnaires are stamped
   * with the project's id on save.
   */
  project?: Project | null;
  onClose: () => void;
  onSelectQuestionnaire?: (questionnaire: Questionnaire) => void;
}

export const QuestionnaireManager: React.FC<QuestionnaireManagerProps> = ({
  project,
  onClose,
  onSelectQuestionnaire
}) => {
  const scopeProjectId = project?.id;
  const [questionnaires, setQuestionnaires] = useState<Questionnaire[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Questionnaire | 'new' | null>(null);
  const [viewingResponses, setViewingResponses] = useState<Questionnaire | null>(null);
  const [search, setSearch] = useState('');
  const [copyFromOpen, setCopyFromOpen] = useState(false);

  const fetchQuestionnaires = async () => {
    try {
      setLoading(true);
      setFetchError(null);
      const result = await geosurveyApi.listQuestionnaires();
      const list = result.items as unknown as Questionnaire[];
      // Sort newest first by `updatedAt` — values may be Firestore Timestamps,
      // ISO strings, or pending serverTimestamp placeholders; `toMillis` handles
      // all of those without throwing (the previous `localeCompare` crash
      // silently swallowed the whole result set, hiding just-saved drafts).
      list.sort((a, b) => toMillis(b.updatedAt) - toMillis(a.updatedAt));
      // Scope by current project. Legacy questionnaires without `projectId`
      // are treated as belonging to the canonical default project so they
      // don't disappear after the project layer was introduced.
      const filtered = scopeProjectId
        ? list.filter((it) => {
            const pid = it.projectId || DEFAULT_PROJECT_ID;
            return pid === scopeProjectId;
          })
        : list;
      setQuestionnaires(filtered);
    } catch (error) {
      console.error('Error fetching questionnaires:', error);
      const msg =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Failed to load questionnaires.';
      setFetchError(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchQuestionnaires();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeProjectId]);

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this questionnaire? This cannot be undone.')) return;
    try {
      await geosurveyApi.deleteQuestionnaire(id);
      setQuestionnaires((prev) => prev.filter((q) => q.id !== id));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, 'questionnaires');
    }
  };

  const handleDuplicate = async (q: Questionnaire, targetProjectId?: string) => {
    try {
      const { id: _omit, ...rest } = q;
      void _omit;
      const now = new Date().toISOString();
      const destProjectId =
        targetProjectId || rest.projectId || scopeProjectId || DEFAULT_PROJECT_ID;
      const dup = {
        ...rest,
        projectId: destProjectId,
        title: `${q.title} (Copy)`,
        isActive: false,
        createdAt: now,
        updatedAt: now
      };
      const ref = await geosurveyApi.saveQuestionnaire(dup as Record<string, unknown>);
      const created: Questionnaire = {
        ...(dup as Questionnaire),
        ...(ref as unknown as Questionnaire),
        id: String((ref as { id?: string }).id ?? ''),
        projectId: destProjectId
      };
      if (!scopeProjectId || destProjectId === scopeProjectId) {
        setQuestionnaires((prev) => [created, ...prev]);
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'questionnaires');
    }
  };

  const toggleActive = async (q: Questionnaire) => {
    try {
      await geosurveyApi.saveQuestionnaire({
        ...q,
        isActive: !q.isActive,
        updatedAt: new Date().toISOString()
      });
      setQuestionnaires((prev) =>
        prev.map((x) => (x.id === q.id ? { ...x, isActive: !x.isActive } : x))
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, 'questionnaires');
    }
  };

  if (editing) {
    return (
      <QuestionnaireBuilder
        questionnaire={editing === 'new' ? undefined : editing}
        projectId={scopeProjectId}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          await fetchQuestionnaires();
          setEditing(null);
        }}
      />
    );
  }

  if (viewingResponses) {
    return (
      <React.Suspense
        fallback={
          <div className="min-h-screen flex items-center justify-center bg-slate-50">
            <div className="flex items-center gap-3 text-slate-600">
              <div className="w-5 h-5 border-2 border-slate-300 border-t-blue-600 rounded-full animate-spin" />
              <span className="text-sm font-medium">Loading responses…</span>
            </div>
          </div>
        }
      >
        <QuestionnaireResponsesView
          questionnaire={viewingResponses}
          onClose={() => setViewingResponses(null)}
        />
      </React.Suspense>
    );
  }

  const filtered = questionnaires.filter((q) => {
    const s = search.trim().toLowerCase();
    if (!s) return true;
  return (
      q.title.toLowerCase().includes(s) ||
      (q.description || '').toLowerCase().includes(s) ||
      (q.version || '').toLowerCase().includes(s)
    );
  });

  return (
    <div className="fixed inset-0 z-[1005] bg-slate-50 flex flex-col pt-[env(safe-area-inset-top,0px)]">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center">
            <FileText className="text-blue-600" size={20} />
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-900">Questionnaire Builder</h1>
            <p className="text-xs text-slate-500">
              {project
                ? `Project · ${project.name}${project.code ? ` (${project.code})` : ''}`
                : 'Design, configure, and publish field surveys'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {scopeProjectId && (
            <button
              type="button"
              onClick={() => setCopyFromOpen(true)}
              className="bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 font-semibold text-sm px-4 py-2 rounded-lg flex items-center gap-2 transition-colors"
              title="Copy a questionnaire from another project"
            >
              <FolderInput size={16} />
              Copy from project
            </button>
          )}
          <button
            onClick={() => setEditing('new')}
            className="bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm px-4 py-2 rounded-lg flex items-center gap-2 transition-colors"
          >
            <Plus size={16} />
            New Questionnaire
          </button>
          <button
            onClick={onClose}
            className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg transition-colors"
            title="Close"
          >
            <X size={20} />
          </button>
        </div>
      </header>

      {/* Search bar */}
      <div className="bg-white border-b border-slate-200 px-6 py-3">
        <div className="relative max-w-xl">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search questionnaires by title, description, or version…"
            className="w-full pl-10 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-6">
        {fetchError && (
          <div className="max-w-7xl mb-4 bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3 flex items-start gap-3">
            <AlertCircle size={18} className="shrink-0 mt-0.5" />
            <div className="flex-1 text-sm">
              <p className="font-semibold">Could not load questionnaires.</p>
              <p className="text-xs text-red-700/80 mt-0.5">{fetchError}</p>
            </div>
            <button
              onClick={() => void fetchQuestionnaires()}
              className="text-xs font-semibold text-red-700 hover:text-red-900 underline"
            >
              Retry
            </button>
          </div>
        )}
        {loading ? (
          <div className="text-center text-slate-500 py-20">Loading questionnaires…</div>
        ) : filtered.length === 0 ? (
          <div className="text-center text-slate-500 py-20">
            <FileText size={48} className="mx-auto mb-4 text-slate-300" />
            <p className="font-medium">
              {questionnaires.length === 0 ? 'No questionnaires yet' : 'No matches'}
            </p>
            <p className="text-sm">
              {questionnaires.length === 0
                ? scopeProjectId
                  ? 'Create a new survey, or copy one from another project.'
                  : 'Click "New Questionnaire" to start building your first survey.'
                : 'Try a different search term.'}
            </p>
            {questionnaires.length === 0 && scopeProjectId && (
              <button
                type="button"
                onClick={() => setCopyFromOpen(true)}
                className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-blue-700 hover:text-blue-800"
              >
                <FolderInput size={15} />
                Copy from another project
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 max-w-7xl">
            {filtered.map((q) => (
              <div
                key={q.id}
                className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden hover:shadow-md transition-shadow"
              >
                <div className="p-5">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <h3 className="font-bold text-slate-900 leading-tight">{q.title}</h3>
                    <span
                      className={`shrink-0 text-[10px] font-bold uppercase px-2 py-1 rounded-full ${
                        q.isActive
                          ? 'bg-green-100 text-green-700'
                          : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      {q.isActive ? 'Active' : 'Draft'}
                      </span>
                    </div>
                  {q.description && (
                    <p className="text-sm text-slate-600 line-clamp-2 mb-3">{q.description}</p>
                  )}
                  <div className="flex items-center gap-2 text-xs text-slate-500 flex-wrap">
                    <span>v{q.version || '1.0'}</span>
                    <span>•</span>
                    <span>{q.questions?.length || 0} questions</span>
                    {q.sections && q.sections.length > 0 && (
                      <>
                        <span>•</span>
                        <span>{q.sections.length} sections</span>
                      </>
                    )}
                  </div>
                  <div className="text-[10px] text-slate-400 mt-1.5">
                    Updated {formatTimestamp(q.updatedAt)}
                </div>
                </div>
                <div className="border-t border-slate-100 px-3 py-2 bg-slate-50/60 flex items-center gap-1">
                  <button
                    onClick={() => setEditing(q)}
                    className="flex-1 text-xs font-semibold text-blue-700 hover:bg-blue-50 px-2 py-1.5 rounded flex items-center justify-center gap-1"
                  >
                    <Edit3 size={13} /> Edit
                  </button>
                  <button
                    onClick={() => setViewingResponses(q)}
                    className="flex-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 px-2 py-1.5 rounded flex items-center justify-center gap-1"
                  >
                    <Inbox size={13} /> Responses
                  </button>
                  {onSelectQuestionnaire && (
                    <button
                      onClick={() => onSelectQuestionnaire(q)}
                      className="text-xs font-semibold text-green-700 hover:bg-green-50 px-2 py-1.5 rounded flex items-center justify-center gap-1"
                      title="Preview"
                    >
                      <Eye size={13} />
                    </button>
                  )}
                  <button
                    onClick={() => handleDuplicate(q)}
                    className="text-xs font-semibold text-slate-700 hover:bg-slate-100 px-2 py-1.5 rounded flex items-center justify-center gap-1"
                    title="Duplicate"
                  >
                    <Copy size={13} />
                  </button>
                  <button
                    onClick={() => toggleActive(q)}
                    className={`text-xs font-semibold px-2 py-1.5 rounded flex items-center justify-center gap-1 ${
                      q.isActive
                        ? 'text-amber-700 hover:bg-amber-50'
                        : 'text-emerald-700 hover:bg-emerald-50'
                    }`}
                    title={q.isActive ? 'Deactivate' : 'Activate'}
                  >
                    <Power size={13} />
                  </button>
                  <button
                    onClick={() => handleDelete(q.id)}
                    className="text-xs font-semibold text-red-700 hover:bg-red-50 px-2 py-1.5 rounded flex items-center justify-center gap-1"
                    title="Delete"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <AppFooter className="border-t border-slate-200 bg-white/70 backdrop-blur" />
      {copyFromOpen && scopeProjectId && (
        <CopyFromProjectModal
          currentProjectId={scopeProjectId}
          currentProjectName={project?.name}
          onClose={() => setCopyFromOpen(false)}
          onCopied={(created) => {
            setQuestionnaires((prev) => [created, ...prev.filter((q) => q.id !== created.id)]);
            setCopyFromOpen(false);
          }}
        />
      )}
    </div>
  );
};

// ===========================================================================
// QuestionnaireBuilder — the actual full-screen builder UI
// ===========================================================================

interface QuestionnaireBuilderProps {
  questionnaire?: Questionnaire;
  /** Active project to stamp on save; falls back to `DEFAULT_PROJECT_ID`. */
  projectId?: string;
  onClose: () => void;
  onSaved: () => void;
}

const QuestionnaireBuilder: React.FC<QuestionnaireBuilderProps> = ({
  questionnaire,
  projectId,
  onClose,
  onSaved
}) => {
  // Effective project to stamp on this questionnaire — preserve existing
  // `projectId` on edit, otherwise use the project the picker was opened in.
  const scopeProjectId = questionnaire?.projectId || projectId;
  const { user } = useAuth();

  // ----- Draft state (normalize legacy option strings to QuestionOption[]) ---
  const [title, setTitle] = useState(questionnaire?.title || 'Untitled Questionnaire');
  // Description supports rich blocks (headings/paragraphs/tables). Old
  // questionnaires that only have a plain `description` string migrate into a
  // single paragraph block on first load.
  const [descriptionBlocks, setDescriptionBlocks] = useState<DescriptionBlock[]>(() => {
    if (questionnaire?.descriptionBlocks && questionnaire.descriptionBlocks.length > 0) {
      return questionnaire.descriptionBlocks;
    }
    const plain = (questionnaire?.description || '').trim();
    if (plain) {
      return [{ id: uid('b'), type: 'paragraph', text: plain }];
    }
    return [];
  });
  const [conclusionBlocks, setConclusionBlocks] = useState<DescriptionBlock[]>(() => {
    if (questionnaire?.conclusionBlocks && questionnaire.conclusionBlocks.length > 0) {
      return questionnaire.conclusionBlocks;
    }
    const plain = (questionnaire?.conclusion || '').trim();
    if (plain) {
      return [{ id: uid('b'), type: 'paragraph', text: plain }];
    }
    return [];
  });
  const [version, setVersion] = useState(questionnaire?.version || '1.0');
  const [isActive, setIsActive] = useState(questionnaire?.isActive ?? false);
  const [settings, setSettings] = useState<QuestionnaireSettings>(
    questionnaire?.settings || {
      showProgress: true,
      allowSaveDraft: true,
      paginated: false,
      captureLocation: true,
      shuffleQuestions: false
    }
  );
  const [questions, setQuestions] = useState<Question[]>(() => {
    const src = questionnaire?.questions || [];
    return src.map((q) => ({
      ...q,
      options: ensureOptionShape(q.options),
      validation: q.validation || {},
      logic: q.logic || blankLogic()
    }));
  });
  const [sections, setSections] = useState<QuestionnaireSection[]>(
    questionnaire?.sections || []
  );
  // Consent / permission gate shown after enumerator info and before the
  // survey questions. Questions are hidden until the enumerator ticks the
  // checkbox confirming they obtained verbal consent from the respondent.
  const [consentGate, setConsentGate] = useState<ConsentGate>(() => {
    if (questionnaire?.consentGate) return questionnaire.consentGate;
    return {
      enabled: true,
      title: 'Permission Grant',
      text:
        'Before starting this survey, the enumerator must obtain verbal consent from the respondent. Please explain the purpose of the survey, that participation is voluntary, that the respondent may decline or stop at any time, and that their responses will be kept confidential and used only for the stated research purposes.',
      checkboxLabel:
        'I confirm that I have obtained verbal consent from the respondent to conduct this survey.',
      substituteEnumeratorName: true
    };
  });

  // End-of-survey GPS capture configuration. Defaults to a 10s stabilization
  // window and a ≤10m accuracy gate — the values the user asked for.
  const [submissionGps, setSubmissionGps] = useState<SubmissionGpsCapture>(() => {
    if (questionnaire?.submissionGps) return questionnaire.submissionGps;
    return {
      enabled: true,
      title: 'Submission GPS Location',
      description:
        'At the end of the survey we capture your device location. Please remain stationary; the GPS will stabilize for a few seconds before a high-accuracy reading is accepted.',
      accuracyMeters: 10,
      stabilizationSeconds: 10,
      required: true
    };
  });

  // Enumerator-info section captured before the actual questions. New
  // questionnaires get a sensible default set; existing ones are loaded as-is.
  const [enumeratorInfo, setEnumeratorInfo] = useState<EnumeratorInfo>(() => {
    if (questionnaire?.enumeratorInfo) return questionnaire.enumeratorInfo;
    return {
      enabled: true,
      title: 'Enumerator Information',
      description:
        'Name, ID, phone and email are filled from your account and cannot be edited.',
      fields: [
        {
          id: uid('q'),
          key: 'enumerator_name',
          type: 'text',
          question: 'Enumerator Name',
          required: true
        },
        {
          id: uid('q'),
          key: 'enumerator_id',
          type: 'text',
          question: 'Enumerator ID',
          required: true
        },
        {
          id: uid('q'),
          key: 'enumerator_phone',
          type: 'phone',
          question: 'Phone',
          required: false
        },
        {
          id: uid('q'),
          key: 'enumerator_email',
          type: 'email',
          question: 'Email',
          required: false
        },
        {
          id: uid('q'),
          key: 'survey_date',
          type: 'date',
          question: 'Date of Survey',
          required: true
        },
        {
          id: uid('q'),
          key: 'survey_area',
          type: 'text',
          question: 'Ward / Area',
          required: false
        }
      ]
    };
  });
  const [selectedId, setSelectedId] = useState<string | null>(
    questions[0]?.id ?? null
  );
  const [rightTab, setRightTab] = useState<'properties' | 'logic' | 'validation'>('properties');
  const [showPreview, setShowPreview] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [saving, setSaving] = useState(false);
  // Transient "Saved · just now" indicator shown next to the save
  // buttons after a `mode === 'save'` write succeeds. We use it
  // instead of closing the editor so admins can keep editing.
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // Once a brand-new questionnaire is saved via the inline "Save"
  // button (which keeps the editor open) we remember the new
  // Firestore document id so subsequent saves are `updateDoc` calls
  // against the same row instead of repeatedly inserting clones.
  const [persistedId, setPersistedId] = useState<string | null>(
    questionnaire?.id || null
  );
  const [paletteFilter, setPaletteFilter] = useState<QuestionTypeDef['group'] | 'all'>('all');

  const selectedQuestion = useMemo(
    () => questions.find((q) => q.id === selectedId) || null,
    [questions, selectedId]
  );

  // ----- Question mutation helpers -----------------------------------------
  const addQuestion = (type: QuestionType) => {
    const q = newDefaultQuestion(type);
    setQuestions((prev) => {
      const selIdx = prev.findIndex((x) => x.id === selectedId);
      if (selIdx < 0) return [...prev, q];
      const next = [...prev];
      next.splice(selIdx + 1, 0, q);
      return next;
    });
    setSelectedId(q.id);
    setRightTab('properties');
  };

  const updateQuestion = (id: string, patch: Partial<Question>) => {
    setQuestions((prev) => prev.map((q) => (q.id === id ? { ...q, ...patch } : q)));
  };

  const removeQuestion = (id: string) => {
    setQuestions((prev) => {
      // Any sub-questions parented under the one being deleted get
      // promoted back to top-level so they don't become orphans
      // pointing at a non-existent parent.
      const next = prev
        .filter((q) => q.id !== id)
        .map((q) => (q.parentId === id ? { ...q, parentId: undefined } : q));
      if (selectedId === id) {
        setSelectedId(next[0]?.id ?? null);
      }
      return next;
    });
  };

  /**
   * Set / clear the `parentId` for a single question. Enforces the
   * single-level nesting rule:
   * - Sections, computed, and matrix questions never become sub-
   *   questions (they're structural blocks).
   * - A question that already has its own children can't itself
   *   become a child (would make a grandchild).
   * - The new parent must be a top-level, non-section question
   *   (otherwise we'd be nesting under another child).
   *
   * Pass `null` as `newParentId` to promote a child back to top level.
   */
  const setQuestionParent = (id: string, newParentId: string | null) => {
    setQuestions((prev) => {
      const target = prev.find((q) => q.id === id);
      if (!target) return prev;
      if (target.type === 'section') return prev;
      // Children can't become parents (single-level only).
      const hasChildren = prev.some((q) => q.parentId === id);
      if (newParentId && hasChildren) {
        alert(
          'This question already has sub-questions and can\u2019t itself become a sub-question. ' +
            'Promote its children back to the top level first.'
        );
        return prev;
      }
      if (newParentId === null) {
        return prev.map((q) =>
          q.id === id ? { ...q, parentId: undefined } : q
        );
      }
      if (newParentId === id) return prev;
      const parent = prev.find((q) => q.id === newParentId);
      if (!parent) return prev;
      if (parent.type === 'section') return prev;
      if (parent.parentId) {
        alert('Pick a top-level question as the parent (no sub-sub-questions).');
        return prev;
      }
      // Move the child to sit right after its parent's last existing
      // child in the flat array so the canvas renders it inline.
      const next = prev.filter((q) => q.id !== id);
      const updated = { ...target, parentId: newParentId };
      const parentIdx = next.findIndex((q) => q.id === newParentId);
      if (parentIdx < 0) return [...next, updated];
      let insertAt = parentIdx + 1;
      while (
        insertAt < next.length &&
        next[insertAt].parentId === newParentId
      ) {
        insertAt += 1;
      }
      next.splice(insertAt, 0, updated);
      return next;
    });
  };

  /** Add a new sub-question parented under `parentId`. */
  const addChildQuestion = (parentId: string, type: QuestionType) => {
    const parent = questions.find((q) => q.id === parentId);
    if (!parent || parent.type === 'section' || parent.parentId) return;
    const child: Question = { ...newDefaultQuestion(type), parentId };
    setQuestions((prev) => {
      const next = [...prev];
      const parentIdx = next.findIndex((q) => q.id === parentId);
      if (parentIdx < 0) return [...next, child];
      let insertAt = parentIdx + 1;
      while (
        insertAt < next.length &&
        next[insertAt].parentId === parentId
      ) {
        insertAt += 1;
      }
      next.splice(insertAt, 0, child);
      return next;
    });
    setSelectedId(child.id);
    setRightTab('properties');
  };

  const duplicateQuestion = (id: string) => {
    setQuestions((prev) => {
      const idx = prev.findIndex((q) => q.id === id);
      if (idx < 0) return prev;
      const copy: Question = {
        ...prev[idx],
        id: uid('q'),
        question: `${prev[idx].question} (copy)`,
        options: prev[idx].options
          ? (ensureOptionShape(prev[idx].options).map((o) => ({ ...o, id: uid('o') })) as QuestionOption[])
          : undefined
      };
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
  };

  const moveQuestion = (id: string, dir: -1 | 1) => {
    setQuestions((prev) => {
      const idx = prev.findIndex((q) => q.id === id);
      if (idx < 0) return prev;
      const target = prev[idx];

      // Children move among siblings of the same parent only, so we
      // don't accidentally tear them out of their group when the admin
      // hits the up/down arrow. Top-level questions move among other
      // top-level entries; their children come along for the ride.
      if (target.parentId) {
        const siblings = prev
          .map((q, i) => ({ q, i }))
          .filter((x) => x.q.parentId === target.parentId);
        const order = siblings.findIndex((x) => x.q.id === id);
        const swap = siblings[order + dir];
        if (!swap) return prev;
        const next = [...prev];
        [next[idx], next[swap.i]] = [next[swap.i], next[idx]];
        return next;
      }

      // Top-level move — find the previous / next top-level entry and
      // swap the whole `[parent, ...its children]` block with the
      // adjacent block so children travel with their parent.
      const topLevelPositions = prev
        .map((q, i) => ({ q, i }))
        .filter((x) => !x.q.parentId);
      const tlOrder = topLevelPositions.findIndex((x) => x.q.id === id);
      if (tlOrder < 0) return prev;
      const swapTl = topLevelPositions[tlOrder + dir];
      if (!swapTl) return prev;
      // Block A = [idx..lastChildOfA], Block B = [swapTl.i..lastChildOfB].
      const blockOf = (startIdx: number) => {
        const parent = prev[startIdx];
        let end = startIdx + 1;
        while (end < prev.length && prev[end].parentId === parent.id) end += 1;
        return prev.slice(startIdx, end);
      };
      const blockA = blockOf(idx);
      const blockB = blockOf(swapTl.i);
      // Whichever is earlier in the array goes first in the splice
      // reconstruction so we don't mis-order the surrounding entries.
      const [firstStart, firstBlock, secondStart, secondBlock] =
        idx < swapTl.i
          ? [idx, blockA, swapTl.i, blockB]
          : [swapTl.i, blockB, idx, blockA];
      const before = prev.slice(0, firstStart);
      const between = prev.slice(firstStart + firstBlock.length, secondStart);
      const after = prev.slice(secondStart + secondBlock.length);
      return [...before, ...secondBlock, ...between, ...firstBlock, ...after];
    });
  };

  // ----- Save --------------------------------------------------------------
  /**
   * Save modes:
   * - `save`    — persist current edits without changing the publish
   *               flag. Used by the plain "Save" button so admins can
   *               edit an active questionnaire without unpublishing it
   *               (or a draft without accidentally publishing it).
   * - `draft`   — explicitly mark `isActive=false`. Use when you want
   *               to pull a questionnaire offline for editing.
   * - `publish` — explicitly mark `isActive=true` (publish to
   *               enumerators).
   */
  const handleSave = async (mode: 'save' | 'draft' | 'publish') => {
    if (!user) {
      alert('You must be signed in to save. Please refresh and sign in again.');
      return;
    }
    if (!title.trim()) {
      alert('Please provide a title for the questionnaire.');
      return;
    }
    if (questions.length === 0) {
      alert('Add at least one question before saving.');
      return;
    }

    // Auto-fill key (variable name) from question prompt if missing.
    const normalized = questions.map<Question>((q) => ({
      ...q,
      key: (q.key && q.key.trim()) || slugify(q.question) || q.id
    }));

    const nextIsActive =
      mode === 'publish' ? true : mode === 'draft' ? false : isActive;

    setSaving(true);
    try {
      const payload = sanitizeForFirestore({
        title: title.trim(),
        // Stamp the active project so list filtering + per-project user task
        // assignment can reference it. Falls back to the canonical default
        // project when this view was opened without a project context.
        projectId: scopeProjectId || DEFAULT_PROJECT_ID,
        // `description` is a plain-text summary of the rich blocks (for the
        // list card, search, and any legacy reader that ignores blocks).
        description: blocksToPlainText(descriptionBlocks),
        descriptionBlocks,
        conclusion: blocksToPlainText(conclusionBlocks),
        conclusionBlocks,
        enumeratorInfo,
        consentGate,
        submissionGps,
        version: version.trim() || '1.0',
        questions: normalized,
        sections,
        settings,
        isActive: nextIsActive,
        createdBy: user.uid,
        updatedAt: new Date().toISOString(),
        ...(persistedId ? {} : { createdAt: new Date().toISOString() })
      }) as Record<string, unknown>;
      if (persistedId) {
        await geosurveyApi.saveQuestionnaire({ ...payload, id: persistedId });
      } else {
        const created = await geosurveyApi.saveQuestionnaire(payload);
        // Remember the new doc id so subsequent "Save" clicks update
        // the same row instead of inserting clones.
        setPersistedId(String((created as { id?: string }).id ?? ''));
      }
      // Reflect the new publish state locally so the badge in the
      // toolbar updates immediately (otherwise "Active" / "Draft"
      // would lag until the parent reloads us).
      if (nextIsActive !== isActive) setIsActive(nextIsActive);

      if (mode === 'save') {
        // Inline save — keep the editor open and surface a transient
        // "Saved · just now" indicator next to the toolbar buttons.
        // The list view will pick up the change on its next snapshot;
        // we don't need to close the modal for that.
        setSavedAt(Date.now());
      } else {
        onSaved();
      }
    } catch (error) {
      console.error('Questionnaire save failed:', error);
      try {
        handleFirestoreError(
          error,
          persistedId ? OperationType.UPDATE : OperationType.CREATE,
          'questionnaires'
        );
      } catch {
        /* handleFirestoreError rethrows after logging */
      }
      const msg =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Save failed (see console for details).';
      alert(`Could not save questionnaire: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  // Auto-dismiss the "Saved · just now" pill after a few seconds so it
  // doesn't sit there forever and start looking stale.
  useEffect(() => {
    if (savedAt === null) return;
    const t = window.setTimeout(() => setSavedAt(null), 4000);
    return () => window.clearTimeout(t);
  }, [savedAt]);

  // -------------------------------------------------------------------------
  return (
    <div className="fixed inset-0 z-[1005] bg-slate-100 flex flex-col pt-[env(safe-area-inset-top,0px)]">
      {/* Top toolbar */}
      <header className="bg-white border-b border-slate-200 px-4 py-3 flex flex-nowrap items-center gap-2 overflow-x-auto overscroll-x-contain shadow-sm">
        <button
          onClick={onClose}
          className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg transition-colors"
          title="Back to list"
        >
          <X size={18} />
        </button>
        <div className="flex-1 min-w-0">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full text-lg font-bold text-slate-900 bg-transparent border-0 focus:outline-none focus:ring-0 truncate"
            placeholder="Questionnaire title"
          />
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span>v{version || '1.0'}</span>
            <span>•</span>
            <span>{questions.length} questions</span>
            <span>•</span>
            <span className={isActive ? 'text-green-600 font-semibold' : ''}>
              {isActive ? 'Active' : 'Draft'}
            </span>
      </div>
        </div>
        <button
          onClick={() => setShowSettings(true)}
          className="px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 rounded-lg flex items-center gap-1.5 transition-colors"
          title="Questionnaire settings"
        >
          <Settings size={16} /> Settings
        </button>
        <button
          onClick={() => setShowPreview(true)}
          className="px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 rounded-lg flex items-center gap-1.5 transition-colors"
        >
          <Eye size={16} /> Preview
        </button>
        {savedAt !== null && (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5">
            <CheckCircle size={12} /> Saved · just now
          </span>
        )}
        <button
          onClick={() => void handleSave('save')}
          disabled={saving}
          className="px-3 py-2 text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg flex items-center gap-1.5 transition-colors disabled:opacity-50"
          title={
            persistedId
              ? isActive
                ? 'Save edits — keeps the questionnaire published and stays on this page'
                : 'Save edits — keeps the questionnaire as a draft and stays on this page'
              : 'Save the current edits and stay on this page'
          }
        >
          <Save size={16} /> {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={() => void handleSave('draft')}
          disabled={saving}
          className="px-3 py-2 text-sm font-semibold text-slate-700 border border-slate-200 hover:bg-slate-50 rounded-lg flex items-center gap-1.5 transition-colors disabled:opacity-50"
          title="Save and mark as draft (hidden from enumerators)"
        >
          <Save size={16} /> {saving ? 'Saving…' : 'Save Draft'}
        </button>
        <button
          onClick={() => void handleSave('publish')}
          disabled={saving}
          className="px-4 py-2 text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg flex items-center gap-1.5 transition-colors disabled:opacity-50"
          title="Save and publish to enumerators"
        >
          <CheckCircle size={16} /> {saving ? 'Publishing…' : 'Save & Publish'}
        </button>
      </header>

      {/* Body: 3-column layout */}
      <div className="flex-1 grid grid-cols-12 overflow-hidden">
        {/* Left: question type palette */}
        <aside className="col-span-12 md:col-span-3 lg:col-span-2 bg-white border-r border-slate-200 flex flex-col overflow-hidden">
          <div className="p-3 border-b border-slate-100">
            <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
              Add Question
            </h3>
            <select
              value={paletteFilter}
              onChange={(e) => setPaletteFilter(e.target.value as QuestionTypeDef['group'] | 'all')}
              className="w-full text-xs px-2 py-1.5 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">All types</option>
              <option value="text">Text</option>
              <option value="numeric">Numeric</option>
              <option value="choice">Choice</option>
              <option value="datetime">Date & Time</option>
              <option value="media">Location & Media</option>
              <option value="advanced">Advanced</option>
            </select>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {QUESTION_TYPES.filter(
              (t) => paletteFilter === 'all' || t.group === paletteFilter
            ).map((def) => (
              <button
                key={def.type}
                onClick={() => addQuestion(def.type)}
                className="w-full flex items-center gap-2 px-2 py-2 rounded-md text-left hover:bg-blue-50 hover:text-blue-700 text-slate-700 transition-colors group"
              >
                <def.Icon size={16} className="text-slate-500 group-hover:text-blue-600 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold leading-tight truncate">{def.label}</div>
                  <div className="text-[10px] text-slate-400 group-hover:text-blue-500 truncate">
                    {def.hint}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </aside>

        {/* Center: canvas */}
        <main className="col-span-12 md:col-span-6 lg:col-span-7 overflow-y-auto p-6 bg-slate-50">
          <div className="max-w-3xl mx-auto space-y-4">
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                Description
              </div>
              <DescriptionEditor blocks={descriptionBlocks} onChange={setDescriptionBlocks} />
            </div>

            <EnumeratorInfoEditor info={enumeratorInfo} onChange={setEnumeratorInfo} />

            <ConsentGateEditor gate={consentGate} onChange={setConsentGate} />

            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                Conclusion
              </div>
              <p className="text-[11px] text-slate-500 mb-3">
                Shown after the last question (before submission GPS if enabled). Use for thank-you
                text, reminders, or contact details.
              </p>
              <DescriptionEditor blocks={conclusionBlocks} onChange={setConclusionBlocks} />
            </div>

            {questions.length === 0 ? (
              <div className="bg-white rounded-xl border-2 border-dashed border-slate-300 p-12 text-center">
                <FileText size={40} className="mx-auto mb-3 text-slate-300" />
                <p className="text-sm font-semibold text-slate-700 mb-1">
                  Your canvas is empty
                </p>
                <p className="text-xs text-slate-500">
                  Pick a question type from the left panel to add your first question.
                </p>
              </div>
            ) : (
              (() => {
                // Hierarchical render: top-level entries first (in their
                // own order), each followed by their sub-questions in
                // array order. Numbering is per-type for top-level (Q N
                // for questions, Section N for dividers) and `parent.a /
                // .b / …` for children.
                const rendered: React.ReactNode[] = [];
                let qNum = 0;
                let secNum = 0;
                const topLevelOrder = questions.filter((x) => !x.parentId);
                questions.forEach((q, idx) => {
                  if (q.parentId) return; // children handled inline
                  const isSection = q.type === 'section';
                  const displayNumber = isSection ? ++secNum : ++qNum;
                  const childrenWithIdx = questions
                    .map((c, ci) => ({ c, ci }))
                    .filter((x) => x.c.parentId === q.id);
                  const topPos = topLevelOrder.findIndex((x) => x.id === q.id);
                  rendered.push(
                    <QuestionCard
                      key={q.id}
                      index={idx}
                      displayNumber={displayNumber}
                      displayLabel={String(displayNumber)}
                      depth={0}
                      question={q}
                      allQuestions={questions}
                      hasChildren={childrenWithIdx.length > 0}
                      selected={selectedId === q.id}
                      onSelect={() => {
                        setSelectedId(q.id);
                        setRightTab('properties');
                      }}
                      onUpdate={(patch) => updateQuestion(q.id, patch)}
                      onRemove={() => removeQuestion(q.id)}
                      onDuplicate={() => duplicateQuestion(q.id)}
                      onMoveUp={() => moveQuestion(q.id, -1)}
                      onMoveDown={() => moveQuestion(q.id, 1)}
                      canMoveUp={topPos > 0}
                      canMoveDown={topPos < topLevelOrder.length - 1}
                      onAddChild={
                        isSection
                          ? undefined
                          : (type) => addChildQuestion(q.id, type)
                      }
                      onChangeParent={(newParentId) =>
                        setQuestionParent(q.id, newParentId)
                      }
                    />
                  );
                  childrenWithIdx.forEach(({ c, ci }, childOrder) => {
                    const letter = String.fromCharCode(97 + childOrder); // a, b, c…
                    rendered.push(
                      <QuestionCard
                        key={c.id}
                        index={ci}
                        displayNumber={displayNumber}
                        displayLabel={`${displayNumber}.${letter}`}
                        depth={1}
                        question={c}
                        allQuestions={questions}
                        hasChildren={false}
                        selected={selectedId === c.id}
                        onSelect={() => {
                          setSelectedId(c.id);
                          setRightTab('properties');
                        }}
                        onUpdate={(patch) => updateQuestion(c.id, patch)}
                        onRemove={() => removeQuestion(c.id)}
                        onDuplicate={() => duplicateQuestion(c.id)}
                        onMoveUp={() => moveQuestion(c.id, -1)}
                        onMoveDown={() => moveQuestion(c.id, 1)}
                        canMoveUp={childOrder > 0}
                        canMoveDown={childOrder < childrenWithIdx.length - 1}
                        onChangeParent={(newParentId) =>
                          setQuestionParent(c.id, newParentId)
                        }
                      />
                    );
                  });
                });
                return rendered;
              })()
            )}

            <SubmissionGpsEditor gps={submissionGps} onChange={setSubmissionGps} />
          </div>
        </main>

        {/* Right: properties / logic / validation */}
        <aside className="col-span-12 md:col-span-3 lg:col-span-3 bg-white border-l border-slate-200 flex flex-col overflow-hidden">
          {selectedQuestion ? (
            <>
              <div className="border-b border-slate-200 px-1 pt-1 flex">
                {(
                  [
                    { id: 'properties', label: 'Properties', Icon: Settings },
                    { id: 'validation', label: 'Validation', Icon: AlertCircle },
                    { id: 'logic', label: 'Logic', Icon: Filter }
                  ] as const
                ).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setRightTab(t.id)}
                    className={`flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold py-2.5 border-b-2 transition-colors ${
                      rightTab === t.id
                        ? 'border-blue-600 text-blue-700'
                        : 'border-transparent text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    <t.Icon size={13} />
                    {t.label}
                  </button>
                ))}
              </div>

              <div className="flex-1 overflow-y-auto p-4">
                {rightTab === 'properties' && (
                  <PropertiesPanel
                    question={selectedQuestion}
                    allQuestions={questions}
                    onUpdate={(patch) => updateQuestion(selectedQuestion.id, patch)}
                  />
                )}
                {rightTab === 'validation' && (
                  <ValidationPanel
                    question={selectedQuestion}
                    onUpdate={(patch) => updateQuestion(selectedQuestion.id, patch)}
                  />
                )}
                {rightTab === 'logic' && (
                  <LogicPanel
                    question={selectedQuestion}
                    allQuestions={questions}
                    onUpdate={(patch) => updateQuestion(selectedQuestion.id, patch)}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center p-6 text-center text-slate-500">
        <div>
                <Settings size={36} className="mx-auto mb-3 text-slate-300" />
                <p className="text-sm font-medium">No question selected</p>
                <p className="text-xs">Click a question on the canvas to edit it.</p>
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* Settings dialog */}
      {showSettings && (
        <SettingsDialog
          version={version}
          onVersionChange={setVersion}
          isActive={isActive}
          onIsActiveChange={setIsActive}
          settings={settings}
          onSettingsChange={setSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {/* Preview dialog */}
      {showPreview && (
        <PreviewDialog
          title={title}
          descriptionBlocks={descriptionBlocks}
          conclusionBlocks={conclusionBlocks}
          enumeratorInfo={enumeratorInfo}
          consentGate={consentGate}
          submissionGps={submissionGps}
          version={version}
          questions={questions}
          settings={settings}
          onClose={() => setShowPreview(false)}
        />
      )}
    </div>
  );
};

// ===========================================================================
// QuestionCard — single question on the canvas
// ===========================================================================

interface QuestionCardProps {
  /** Position in the raw `questions` array (used for move buttons). */
  index: number;
  /** Numeric position of the top-level question this card belongs to. */
  displayNumber: number;
  /** Pre-formatted label shown on the chip ("3" for parents, "3.a" for children). */
  displayLabel: string;
  /** 0 = top level, 1 = sub-question. */
  depth: number;
  question: Question;
  /** Full question list — used by the "Move under…" picker. */
  allQuestions: Question[];
  /** True when this top-level question has at least one sub-question. */
  hasChildren: boolean;
  selected: boolean;
  onSelect: () => void;
  onUpdate: (patch: Partial<Question>) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** Called when admin clicks "Add sub-question" on a top-level card. */
  onAddChild?: (type: QuestionType) => void;
  /** Set / clear `parentId` for this card. */
  onChangeParent: (newParentId: string | null) => void;
}

const QuestionCard: React.FC<QuestionCardProps> = ({
  index: _index,
  displayNumber,
  displayLabel,
  depth,
  question,
  allQuestions,
  hasChildren,
  selected,
  onSelect,
  onUpdate,
  onRemove,
  onDuplicate,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  onAddChild,
  onChangeParent
}) => {
  const typeDef = QUESTION_TYPE_BY_KEY[question.type];
  const isSection = question.type === 'section';
  const isChild = depth > 0;
  const [moveUnderOpen, setMoveUnderOpen] = useState(false);

  // Eligible parents for the "Move under" picker: every other
  // top-level non-section question. We deliberately allow `computed`
  // and `matrix` parents — a common pattern is a computed "total"
  // heading with the operand sub-questions nested directly under it.
  // Sections never become parents (they're structural dividers).
  const eligibleParents = allQuestions.filter(
    (p) =>
      p.id !== question.id &&
      !p.parentId &&
      p.type !== 'section' &&
      !hasChildren // a parent with children can't itself become a child
  );

  return (
    <div
      onClick={onSelect}
      className={`bg-white rounded-xl border-2 transition-all cursor-pointer ${
        selected ? 'border-blue-500 shadow-md' : 'border-slate-200 hover:border-slate-300'
      } ${isSection ? 'bg-indigo-50/30' : ''} ${
        isChild ? 'ml-8 border-l-4 border-l-blue-300' : ''
      }`}
    >
      <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-100 bg-slate-50/60 rounded-t-xl">
        <GripVertical size={14} className="text-slate-300" />
        <span
          className={`text-[10px] font-bold uppercase tracking-wider ${
            isChild ? 'text-blue-600' : 'text-slate-500'
          }`}
        >
          {isSection
            ? `Section ${displayNumber}`
            : isChild
              ? `Sub Q ${displayLabel}`
              : `Q${displayLabel}`}
        </span>
        {typeDef && (
          <span className="flex items-center gap-1 text-[10px] font-semibold text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">
            <typeDef.Icon size={11} />
            {typeDef.label}
          </span>
        )}
        {question.required && (
          <span className="text-[10px] font-bold text-red-600">Required</span>
        )}
        {question.logic?.enabled && question.logic.conditions.length > 0 && (
          <span className="flex items-center gap-1 text-[10px] font-semibold text-purple-700 bg-purple-50 px-1.5 py-0.5 rounded">
            <Filter size={10} /> Logic
          </span>
        )}
        {question.defaultValueRules && question.defaultValueRules.length > 0 && (
          <span
            className="flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded"
            title={`${question.defaultValueRules.length} default-value rule${question.defaultValueRules.length === 1 ? '' : 's'}`}
          >
            <Lock size={10} /> Auto
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMoveUp();
            }}
            disabled={!canMoveUp}
            className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed"
            title="Move up"
          >
            <ArrowUp size={14} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onMoveDown();
            }}
            disabled={!canMoveDown}
            className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed"
            title="Move down"
          >
            <ArrowDown size={14} />
          </button>
          {/* Nesting controls — only available on non-section questions. */}
          {!isSection && (isChild ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onChangeParent(null);
              }}
              className="p-1 text-blue-500 hover:text-blue-700"
              title="Promote to top-level question"
            >
              <CornerUpLeft size={14} />
            </button>
          ) : !hasChildren && eligibleParents.length > 0 ? (
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMoveUnderOpen((v) => !v);
                }}
                className="p-1 text-slate-400 hover:text-slate-700"
                title="Move under another question (make this a sub-question)"
              >
                <CornerDownRight size={14} />
              </button>
              {moveUnderOpen && (
                <div
                  className="absolute right-0 top-7 z-20 w-64 max-h-64 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg p-1.5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider px-2 py-1">
                    Move under…
                  </div>
                  {eligibleParents.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        onChangeParent(p.id);
                        setMoveUnderOpen(false);
                      }}
                      className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-slate-100 truncate"
                    >
                      {p.question || p.key || p.id}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : null)}
          {/* Add-sub-question shortcut — top-level non-section only. */}
          {onAddChild && !isChild && !isSection && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAddChild('text');
              }}
              className="p-1 text-slate-400 hover:text-slate-700"
              title="Add a sub-question under this one"
            >
              <Plus size={14} />
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDuplicate();
            }}
            className="p-1 text-slate-400 hover:text-slate-700"
            title="Duplicate"
          >
            <Copy size={14} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (confirm('Remove this question?')) onRemove();
            }}
            className="p-1 text-red-400 hover:text-red-600"
            title="Delete"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="p-4 space-y-2">
          <input
            type="text"
          value={question.question}
          onChange={(e) => onUpdate({ question: e.target.value })}
          onClick={(e) => e.stopPropagation()}
          className="w-full text-sm font-semibold text-slate-900 border-0 border-b border-transparent hover:border-slate-200 focus:border-blue-500 focus:outline-none px-0 py-1 bg-transparent"
          placeholder={isSection ? 'Section title…' : 'Type your question…'}
        />
        {question.description !== undefined && (
          <input
            type="text"
            value={question.description}
            onChange={(e) => onUpdate({ description: e.target.value })}
            onClick={(e) => e.stopPropagation()}
            className="w-full text-xs text-slate-500 border-0 focus:outline-none px-0 py-0.5 bg-transparent placeholder-slate-300"
            placeholder="Help text (optional)…"
          />
        )}

        {!isSection && <QuestionPreviewMini question={question} />}
        </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// QuestionPreviewMini — read-only mini preview rendered under each card
// ---------------------------------------------------------------------------

const QuestionPreviewMini: React.FC<{ question: Question }> = ({ question }) => {
  const opts = ensureOptionShape(question.options);
  const inputClass =
    'w-full text-sm border border-slate-200 rounded-md px-2.5 py-1.5 bg-slate-50 text-slate-500 cursor-not-allowed';

  switch (question.type) {
    case 'text':
    case 'email':
    case 'phone':
      return (
        <input
          type="text"
          disabled
          placeholder={question.placeholder || 'Short answer'}
          className={inputClass}
        />
      );
    case 'longtext':
      return (
          <textarea
          disabled
          placeholder={question.placeholder || 'Long answer'}
          rows={2}
          className={`${inputClass} resize-none`}
        />
      );
    case 'number':
      return (
        <input
          type="number"
          disabled
          placeholder={question.placeholder || '0'}
          className={inputClass}
        />
      );
    case 'age':
      return (
        <div className="flex gap-1.5">
          <div className={`${inputClass} flex-1 text-xs flex items-center justify-between`}>
            <span>0</span>
            <span className="text-[10px] uppercase tracking-wider text-slate-400">Years</span>
          </div>
          <div className={`${inputClass} flex-1 text-xs flex items-center justify-between`}>
            <span>0</span>
            <span className="text-[10px] uppercase tracking-wider text-slate-400">Months</span>
          </div>
        </div>
      );
    case 'computed':
      return (
        <div className="flex items-center justify-between gap-2 rounded-md border border-dashed border-violet-300 bg-violet-50/50 text-violet-700 px-2.5 py-1.5 text-xs italic">
          <span className="truncate min-w-0">
            {question.computed?.operation
              ? `Auto: ${computedOpHumanLabel(question.computed.operation)}`
              : 'Auto-calculated value'}
          </span>
          <Sigma size={11} className="shrink-0" />
        </div>
      );
    case 'date':
      return <input type="date" disabled className={inputClass} />;
    case 'time':
      return <input type="time" disabled className={inputClass} />;
    case 'datetime':
      return <input type="datetime-local" disabled className={inputClass} />;
    case 'select':
      return (
        <select disabled className={inputClass}>
          <option>{opts[0]?.label || '— select —'}</option>
        </select>
      );
    case 'multiselect':
      return (
        <div className={`${inputClass} flex flex-wrap gap-1`}>
          {opts.slice(0, 3).map((o) => (
            <span key={o.id} className="text-[10px] bg-white border border-slate-200 rounded px-1.5 py-0.5">
              {o.label}
            </span>
          ))}
          {opts.length > 3 && <span className="text-[10px]">+{opts.length - 3}</span>}
        </div>
      );
    case 'radio':
      return (
        <div className="space-y-1">
          {opts.slice(0, 4).map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-xs text-slate-500">
              <input type="radio" disabled />
              {o.label}
            </label>
          ))}
        </div>
      );
    case 'checkbox':
      return (
        <div className="space-y-1">
          {opts.slice(0, 4).map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-xs text-slate-500">
              <input type="checkbox" disabled />
              {o.label}
            </label>
          ))}
        </div>
      );
    case 'rating':
      return (
        <div className="flex gap-0.5">
          {Array.from({ length: question.validation?.max || 5 }).map((_, i) => (
            <Star key={i} size={18} className="text-amber-300" />
          ))}
        </div>
      );
    case 'scale': {
      const min = question.validation?.min ?? 1;
      const max = question.validation?.max ?? 10;
      return (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span>{min}</span>
          <input type="range" disabled min={min} max={max} className="flex-1" />
          <span>{max}</span>
        </div>
      );
    }
    case 'location': {
      const acc = question.gpsSettings?.accuracyMeters ?? 10;
      const sec = question.gpsSettings?.stabilizationSeconds ?? 10;
      return (
        <div className={`${inputClass} flex items-center gap-2`}>
          <MapPin size={14} />
          <span>Auto-captured GPS</span>
          <span className="ml-auto text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
            ≤ {acc} m · {sec} s
          </span>
        </div>
      );
    }
    case 'photo':
      return (
        <div className={`${inputClass} flex items-center gap-2`}>
          <Camera size={14} /> Capture photo
        </div>
      );
    case 'signature':
      return (
        <div className={`${inputClass} flex items-center gap-2`}>
          <PenTool size={14} /> Sign here
        </div>
      );
    case 'matrix':
      return (
        <div className="overflow-x-auto">
          <table className="text-xs text-slate-500 border-collapse">
            <thead>
              <tr>
                <th />
                {(question.columns || []).map((c) => (
                  <th key={c} className="px-2 py-1 font-normal">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(question.rows || []).map((r) => (
                <tr key={r}>
                  <td className="pr-2 font-medium">{r}</td>
                  {(question.columns || []).map((c) => (
                    <td key={`${r}_${c}`} className="px-2 text-center">
                      <input type="radio" disabled />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
};

// ===========================================================================
// PropertiesPanel — right panel "Properties" tab
// ===========================================================================

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({
  label,
  hint,
  children
}) => (
  <div className="mb-4">
    <label className="block text-xs font-semibold text-slate-700 mb-1">{label}</label>
    {children}
    {hint && <p className="text-[10px] text-slate-400 mt-1">{hint}</p>}
  </div>
);

const inputCls =
  'w-full text-sm px-2.5 py-1.5 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500';

const PropertiesPanel: React.FC<{
  question: Question;
  allQuestions: Question[];
  onUpdate: (patch: Partial<Question>) => void;
}> = ({ question, allQuestions, onUpdate }) => {
  const typeDef = QUESTION_TYPE_BY_KEY[question.type];

  return (
        <div>
      <Field label="Question Type">
        <select
          value={question.type}
          onChange={(e) => onUpdate({ type: e.target.value as QuestionType })}
          className={inputCls}
        >
          {QUESTION_TYPES.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </select>
        <p className="text-[10px] text-slate-400 mt-1">{typeDef?.hint}</p>
      </Field>

      <Field label="Question Prompt">
          <textarea
          value={question.question}
          onChange={(e) => onUpdate({ question: e.target.value })}
          rows={2}
          className={`${inputCls} resize-none`}
          placeholder="What do you want to ask?"
        />
      </Field>

      <Field label="Help / Description" hint="Optional explanation shown below the prompt.">
        <textarea
          value={question.description || ''}
          onChange={(e) => onUpdate({ description: e.target.value })}
          rows={2}
          className={`${inputCls} resize-none`}
          placeholder="Optional"
        />
      </Field>

      <Field
        label="Variable / Field Key"
        hint="Used as the response field id. Auto-generated from the prompt if blank."
      >
            <input
              type="text"
          value={question.key || ''}
          onChange={(e) => onUpdate({ key: e.target.value })}
          className={inputCls}
          placeholder={slugify(question.question) || question.id}
        />
      </Field>

      {(question.type === 'text' ||
        question.type === 'longtext' ||
        question.type === 'email' ||
        question.type === 'phone' ||
        question.type === 'number') && (
        <Field label="Placeholder">
          <input
            type="text"
            value={question.placeholder || ''}
            onChange={(e) => onUpdate({ placeholder: e.target.value })}
            className={inputCls}
            placeholder="Hint inside the input box"
          />
        </Field>
      )}

      <Field label="Required">
        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={question.required}
            onChange={(e) => onUpdate({ required: e.target.checked })}
          />
          Respondent must answer this question
        </label>
      </Field>

      {/* Options editor for choice questions */}
      {isChoiceType(question.type) && (
        <OptionsEditor
          options={ensureOptionShape(question.options)}
          allowOther={question.allowOther || false}
          onChange={(options, allowOther) => onUpdate({ options, allowOther })}
          allQuestions={allQuestions}
          owningQuestionId={question.id}
        />
      )}

      {/* Matrix editor */}
      {question.type === 'matrix' && (
        <MatrixEditor
          rows={question.rows || []}
          columns={question.columns || []}
          onRowsChange={(rows) => onUpdate({ rows })}
          onColumnsChange={(columns) => onUpdate({ columns })}
        />
      )}

      {/* GPS settings — only for location-type questions */}
      {question.type === 'location' && (
        <GpsQuestionSettingsEditor
          settings={question.gpsSettings}
          onChange={(gpsSettings) => onUpdate({ gpsSettings })}
        />
      )}

      {/* Formula editor — only for computed-type questions */}
      {question.type === 'computed' && (
        <ComputedQuestionEditor
          question={question}
          allQuestions={allQuestions}
          onUpdate={onUpdate}
        />
      )}
        </div>
  );
};

// ---------------------------------------------------------------------------
// ComputedQuestionEditor — formula editor for `type === 'computed'`.
// Lets admins pick an operation (sum / multiply / average / …) plus the
// operand questions whose answers feed the formula. Enumerators never
// type a value; the runtime auto-fills it and locks the input.
// ---------------------------------------------------------------------------

const COMPUTED_OPERATIONS: { value: ComputedOperation; label: string; hint: string }[] = [
  { value: 'sum',            label: 'Sum',                   hint: 'A + B + C + …' },
  { value: 'subtract',       label: 'Subtract',              hint: 'A − B − C − …' },
  { value: 'multiply',       label: 'Multiply',              hint: 'A × B × C × …' },
  { value: 'divide',         label: 'Divide',                hint: 'A ÷ B ÷ C ÷ …' },
  { value: 'average',        label: 'Average',               hint: 'Mean of all answered operands' },
  { value: 'min',            label: 'Minimum',               hint: 'Smallest non-empty value' },
  { value: 'max',            label: 'Maximum',               hint: 'Largest non-empty value' },
  { value: 'count_nonempty', label: 'Count answered',        hint: 'Number of operands that have a value' },
  { value: 'concat',         label: 'Join text',             hint: 'Concatenate answers with a separator' },
  { value: 'expression',     label: 'Custom expression',     hint: 'Free formula with {{questionId}} placeholders' }
];

const ComputedQuestionEditor: React.FC<{
  question: Question;
  allQuestions: Question[];
  onUpdate: (patch: Partial<Question>) => void;
}> = ({ question, allQuestions, onUpdate }) => {
  const spec: ComputedSpec = question.computed ?? {
    operation: 'sum',
    operandQuestionIds: [],
    decimals: 2
  };
  const setSpec = (patch: Partial<ComputedSpec>) =>
    onUpdate({ computed: { ...spec, ...patch } });

  const eligible = allQuestions.filter(
    (q) =>
      q.id !== question.id &&
      q.type !== 'section' &&
      q.type !== 'photo' &&
      q.type !== 'signature' &&
      q.type !== 'location' &&
      q.type !== 'matrix' &&
      q.type !== 'computed'
  );
  const operandIds = spec.operandQuestionIds ?? [];

  const addOperand = (id: string) => {
    if (!id) return;
    if (operandIds.includes(id)) return;
    setSpec({ operandQuestionIds: [...operandIds, id] });
  };
  const removeOperand = (id: string) =>
    setSpec({ operandQuestionIds: operandIds.filter((x) => x !== id) });
  const moveOperand = (id: string, dir: -1 | 1) => {
    const idx = operandIds.indexOf(id);
    if (idx < 0) return;
    const next = [...operandIds];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    setSpec({ operandQuestionIds: next });
  };

  const operandLabel = (id: string): string => {
    const q = allQuestions.find((x) => x.id === id);
    if (!q) return id;
    const stem = q.question || q.key || q.id;
    return q.key ? `${stem} · {{${q.key}}}` : stem;
  };

  const isNumericOp =
    spec.operation !== 'concat' && spec.operation !== 'expression';
  const isExpression = spec.operation === 'expression';
  const isConcat = spec.operation === 'concat';

  return (
    <div className="mb-4 rounded-md border border-violet-200 bg-violet-50/30 overflow-hidden">
      <div className="px-3 py-2 bg-violet-100/60 border-b border-violet-200 flex items-center gap-2">
        <Sigma size={14} className="text-violet-700" />
        <span className="text-[11px] font-bold text-violet-800 uppercase tracking-wider">
          Computed Formula
        </span>
      </div>
      <div className="p-3 space-y-3">
        <p className="text-[11px] text-slate-600 leading-snug">
          The answer is calculated automatically from other questions. The
          enumerator sees a read-only value that updates as they fill the
          form.
        </p>

        <Field label="Operation">
          <select
            value={spec.operation}
            onChange={(e) =>
              setSpec({ operation: e.target.value as ComputedOperation })
            }
            className={inputCls}
          >
            {COMPUTED_OPERATIONS.map((op) => (
              <option key={op.value} value={op.value}>
                {op.label}
              </option>
            ))}
          </select>
          <p className="text-[10px] text-slate-400 mt-1">
            {COMPUTED_OPERATIONS.find((o) => o.value === spec.operation)?.hint}
          </p>
        </Field>

        {!isExpression && (
          <Field
            label={isConcat ? 'Text operands (in order)' : 'Operands'}
            hint={
              isConcat
                ? 'Each operand contributes its text answer to the joined result.'
                : 'Operands are read as numbers. Empty / non-numeric answers are skipped (so a partial form still computes a partial result).'
            }
          >
            <div className="space-y-1.5">
              {operandIds.length === 0 && (
                <p className="text-[11px] italic text-slate-400">
                  No operands yet — add one below.
                </p>
              )}
              {operandIds.map((id, i) => (
                <div
                  key={id}
                  className="flex items-center gap-1 bg-white border border-slate-200 rounded px-2 py-1"
                >
                  <span className="text-[10px] font-mono text-slate-400 w-5">
                    {String.fromCharCode(65 + i)}
                  </span>
                  <span className="flex-1 min-w-0 text-xs text-slate-700 truncate">
                    {operandLabel(id)}
                  </span>
                  <button
                    type="button"
                    onClick={() => moveOperand(id, -1)}
                    disabled={i === 0}
                    className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                    title="Move up"
                  >
                    <ArrowUp size={11} />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveOperand(id, 1)}
                    disabled={i === operandIds.length - 1}
                    className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                    title="Move down"
                  >
                    <ArrowDown size={11} />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeOperand(id)}
                    className="p-1 text-red-400 hover:text-red-600"
                    title="Remove operand"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              <select
                value=""
                onChange={(e) => addOperand(e.target.value)}
                className={inputCls}
              >
                <option value="">+ Add operand…</option>
                {eligible
                  .filter((q) => !operandIds.includes(q.id))
                  .map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.question || q.key || q.id}
                    </option>
                  ))}
              </select>
            </div>
          </Field>
        )}

        {isConcat && (
          <Field label="Separator">
            <input
              type="text"
              value={spec.separator ?? ' '}
              onChange={(e) => setSpec({ separator: e.target.value })}
              className={inputCls}
              placeholder=" "
            />
            <p className="text-[10px] text-slate-400 mt-1">
              Text placed between operand answers (default is a single space).
            </p>
          </Field>
        )}

        {isExpression && (
          <>
            <Field
              label="Expression"
              hint="Reference other answers with {{questionId}} or {{questionKey}}. Only + − × ÷ and parentheses are allowed."
            >
              <textarea
                value={spec.expression ?? ''}
                onChange={(e) => setSpec({ expression: e.target.value })}
                rows={2}
                className={`${inputCls} font-mono text-xs resize-none`}
                placeholder="{{income}} * 12 - {{expense_yearly}}"
              />
            </Field>
            <Field
              label="Referenced questions"
              hint="Add every operand you use in the expression so the formula recomputes when those answers change."
            >
              <div className="space-y-1.5">
                {operandIds.length === 0 && (
                  <p className="text-[11px] italic text-slate-400">
                    Add the questions your expression references.
                  </p>
                )}
                {operandIds.map((id) => (
                  <div
                    key={id}
                    className="flex items-center gap-1 bg-white border border-slate-200 rounded px-2 py-1"
                  >
                    <span className="flex-1 min-w-0 text-xs text-slate-700 truncate">
                      {operandLabel(id)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeOperand(id)}
                      className="p-1 text-red-400 hover:text-red-600"
                      title="Remove"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
                <select
                  value=""
                  onChange={(e) => addOperand(e.target.value)}
                  className={inputCls}
                >
                  <option value="">+ Reference a question…</option>
                  {eligible
                    .filter((q) => !operandIds.includes(q.id))
                    .map((q) => (
                      <option key={q.id} value={q.id}>
                        {q.question || q.key || q.id}
                      </option>
                    ))}
                </select>
              </div>
            </Field>
          </>
        )}

        {(isNumericOp || isExpression) && (
          <Field label="Decimal places" hint="Round the result to this many decimals.">
            <input
              type="number"
              min={0}
              max={6}
              step={1}
              value={spec.decimals ?? 2}
              onChange={(e) =>
                setSpec({
                  decimals: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value))
                })
              }
              className={inputCls}
            />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Prefix" hint="e.g. 'BDT '">
            <input
              type="text"
              value={spec.prefix ?? ''}
              onChange={(e) => setSpec({ prefix: e.target.value })}
              className={inputCls}
              placeholder=""
            />
          </Field>
          <Field label="Suffix" hint="e.g. ' m²'">
            <input
              type="text"
              value={spec.suffix ?? ''}
              onChange={(e) => setSpec({ suffix: e.target.value })}
              className={inputCls}
              placeholder=""
            />
          </Field>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// GpsQuestionSettingsEditor — per-`location`-question GPS capture tuning.
// Shares the same accuracy + stabilization model as the end-of-survey
// submission GPS, but is configured independently for each question.
// ---------------------------------------------------------------------------

const DEFAULT_QUESTION_GPS: GpsCaptureSettings = {
  accuracyMeters: 10,
  stabilizationSeconds: 10,
  required: false,
  autoStart: false,
  allowManualOverride: false
};

const GpsQuestionSettingsEditor: React.FC<{
  settings: GpsCaptureSettings | undefined;
  onChange: (settings: GpsCaptureSettings) => void;
}> = ({ settings, onChange }) => {
  const cur: GpsCaptureSettings = { ...DEFAULT_QUESTION_GPS, ...(settings || {}) };
  const patch = (p: Partial<GpsCaptureSettings>) => onChange({ ...cur, ...p });

  return (
    <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50/30 overflow-hidden">
      <div className="px-3 py-2 bg-emerald-100/60 border-b border-emerald-200 flex items-center gap-2">
        <Satellite size={14} className="text-emerald-700" />
        <span className="text-[11px] font-bold text-emerald-800 uppercase tracking-wider">
          GPS Capture Settings
        </span>
      </div>
      <div className="p-3 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">
              Required Accuracy
            </label>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={1}
                step={1}
                value={cur.accuracyMeters}
                onChange={(e) =>
                  patch({ accuracyMeters: Math.max(1, Number(e.target.value) || 0) })
                }
                className={inputCls}
              />
              <span className="text-xs font-semibold text-slate-500">m</span>
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">
              Stabilization
            </label>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={1}
                step={1}
                value={cur.stabilizationSeconds}
                onChange={(e) =>
                  patch({ stabilizationSeconds: Math.max(1, Number(e.target.value) || 0) })
                }
                className={inputCls}
              />
              <span className="text-xs font-semibold text-slate-500">s</span>
            </div>
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-700">
            <input
              type="checkbox"
            checked={!!cur.required}
            onChange={(e) => patch({ required: e.target.checked })}
          />
          Capture must succeed before this question is considered answered
        </label>

        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={!!cur.autoStart}
            onChange={(e) => patch({ autoStart: e.target.checked })}
          />
          Auto-start capture when the question is shown
        </label>

        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={!!cur.allowManualOverride}
            onChange={(e) => patch({ allowManualOverride: e.target.checked })}
          />
          Allow enumerator to "Use anyway" if accuracy gate fails
        </label>

        <p className="text-[10px] text-slate-500 italic">
          Same capture pipeline as the end-of-survey submission GPS. Configure each
          location question independently — e.g. a quick "Approximate landmark"
          could use a relaxed 25 m gate, while "Household entrance" demands ≤ 5 m.
        </p>
          </div>
        </div>
  );
};

// ---------------------------------------------------------------------------
// Option-level "disable when" rule editor (reuses same operators as display logic)
// ---------------------------------------------------------------------------

const OPTION_DISABLE_OPERATORS: { value: LogicOperator; label: string; takesValue: boolean }[] = [
  { value: 'equals', label: 'equals', takesValue: true },
  { value: 'notEquals', label: 'does not equal', takesValue: true },
  { value: 'contains', label: 'contains', takesValue: true },
  { value: 'notContains', label: 'does not contain', takesValue: true },
  { value: 'greaterThan', label: 'is greater than', takesValue: true },
  { value: 'lessThan', label: 'is less than', takesValue: true },
  { value: 'isEmpty', label: 'is empty', takesValue: false },
  { value: 'isNotEmpty', label: 'is not empty', takesValue: false }
];

const OptionDisableWhenEditor: React.FC<{
  rule: LogicRule | undefined;
  onChange: (next: LogicRule | undefined) => void;
  allQuestions: Question[];
  owningQuestionId: string;
}> = ({ rule, onChange, allQuestions, owningQuestionId }) => {
  const referenceable = allQuestions.filter(
    (q) => q.id !== owningQuestionId && q.type !== 'section'
  );
  const active = !!(rule?.enabled && rule.conditions.length > 0);
  const logic: LogicRule = active
    ? (rule as LogicRule)
    : { enabled: true, combinator: 'AND', conditions: [] };

  const setLogic = (patch: Partial<LogicRule>) => {
    if (!active) return;
    onChange({ ...logic, ...patch });
  };

  const addCondition = () => {
    const first = referenceable[0];
    if (!first) {
      alert('Add another question first to reference it in option rules.');
      return;
    }
    const cond: LogicCondition = {
      id: uid('c'),
      questionId: first.id,
      operator: 'equals',
      value: ''
    };
    onChange({
      enabled: true,
      combinator: logic.combinator,
      conditions: [...logic.conditions, cond]
    });
  };

  const updateCond = (id: string, patch: Partial<LogicCondition>) => {
    onChange({
      ...logic,
      conditions: logic.conditions.map((c) => (c.id === id ? { ...c, ...patch } : c))
    });
  };

  const removeCond = (id: string) => {
    const nextConds = logic.conditions.filter((c) => c.id !== id);
    if (nextConds.length === 0) onChange(undefined);
    else onChange({ ...logic, conditions: nextConds });
  };

  return (
    <div className="mt-1.5 pl-2 border-l-2 border-amber-300/90 space-y-1.5">
      <label className="flex items-center gap-2 text-[10px] text-slate-600 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => {
            if (e.target.checked) {
              const first = referenceable[0];
              if (!first) {
                alert('Add another question first to reference it in option rules.');
                return;
              }
              onChange({
                enabled: true,
                combinator: 'AND',
                conditions: [{ id: uid('c'), questionId: first.id, operator: 'equals', value: '' }]
              });
            } else {
              onChange(undefined);
            }
          }}
        />
        Disable when (based on other answers)
      </label>
      {active && (
        <>
          <Field label="Match">
            <div className="inline-flex rounded-md border border-slate-200 overflow-hidden">
              {(['AND', 'OR'] as const).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setLogic({ combinator: c })}
                  className={`px-2 py-0.5 text-[10px] font-bold ${
                    logic.combinator === c
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {c === 'AND' ? 'All (AND)' : 'Any (OR)'}
                </button>
              ))}
            </div>
          </Field>

          <div className="space-y-1.5 mb-1">
            {logic.conditions.map((cond) => {
              const refQ = allQuestions.find((q) => q.id === cond.questionId);
              const opDef = OPTION_DISABLE_OPERATORS.find((o) => o.value === cond.operator);
              const refOpts = refQ ? ensureOptionShape(refQ.options) : [];
              return (
                <div
                  key={cond.id}
                  className="border border-slate-200 rounded-md p-2 bg-white space-y-1"
                >
                  <div className="flex items-center gap-1">
                    <select
                      value={cond.questionId}
                      onChange={(e) => updateCond(cond.id, { questionId: e.target.value })}
                      className="flex-1 text-[10px] px-1.5 py-1 border border-slate-200 rounded bg-white"
                    >
                      {referenceable.map((q) => (
                        <option key={q.id} value={q.id}>
                          {(q.question || '').slice(0, 36) || `(unnamed) ${q.id}`}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => removeCond(cond.id)}
                      className="p-1 text-red-400 hover:text-red-600"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <select
                    value={cond.operator}
                    onChange={(e) =>
                      updateCond(cond.id, { operator: e.target.value as LogicOperator })
                    }
                    className="w-full text-[10px] px-1.5 py-1 border border-slate-200 rounded bg-white"
                  >
                    {OPTION_DISABLE_OPERATORS.map((op) => (
                      <option key={op.value} value={op.value}>
                        {op.label}
                      </option>
                    ))}
                  </select>
                  {opDef?.takesValue && (
                    <>
                      {refQ && isChoiceType(refQ.type) ? (
                        <select
                          value={cond.value || ''}
                          onChange={(e) => updateCond(cond.id, { value: e.target.value })}
                          className="w-full text-[10px] px-1.5 py-1 border border-slate-200 rounded bg-white"
                        >
                          <option value="">— value —</option>
                          {refOpts.map((o) => (
                            <option key={o.id} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={cond.value || ''}
                          onChange={(e) => updateCond(cond.id, { value: e.target.value })}
                          className="w-full text-[10px] px-1.5 py-1 border border-slate-200 rounded bg-white"
                          placeholder="Value to compare"
                        />
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
          <button
            type="button"
            onClick={addCondition}
            className="text-[10px] font-semibold text-blue-700 hover:text-blue-900 flex items-center gap-1"
          >
            <Plus size={11} /> Add condition
          </button>
        </>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// OptionsEditor — manage QuestionOption[] for choice-type questions
// ---------------------------------------------------------------------------

const OptionsEditor: React.FC<{
  options: QuestionOption[];
  allowOther: boolean;
  onChange: (options: QuestionOption[], allowOther: boolean) => void;
  allQuestions: Question[];
  owningQuestionId: string;
}> = ({ options, allowOther, onChange, allQuestions, owningQuestionId }) => {
  const update = (idx: number, patch: Partial<QuestionOption>) => {
    const next = options.map((o, i) => (i === idx ? { ...o, ...patch } : o));
    onChange(next, allowOther);
  };
  const add = () => {
    const next: QuestionOption[] = [
      ...options,
      {
        id: uid('o'),
        value: `option_${options.length + 1}`,
        label: `Option ${options.length + 1}`
      }
    ];
    onChange(next, allowOther);
  };
  const remove = (idx: number) => {
    onChange(
      options.filter((_, i) => i !== idx),
      allowOther
    );
  };
  const move = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= options.length) return;
    const next = [...options];
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange(next, allowOther);
  };

  return (
    <div className="mb-4">
      <label className="block text-xs font-semibold text-slate-700 mb-1">Answer Options</label>
      <div className="space-y-1.5">
        {options.map((o, i) => (
          <div key={o.id} className="space-y-0.5">
            <div className="flex items-center gap-1">
            <input
              type="text"
              value={o.label}
              onChange={(e) => update(i, { label: e.target.value, value: slugify(e.target.value) || e.target.value })}
              className="flex-1 text-sm px-2 py-1 border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder={`Option ${i + 1}`}
            />
            <button
              onClick={() => move(i, -1)}
              disabled={i === 0}
              className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
              title="Up"
            >
              <ChevronUp size={14} />
            </button>
            <button
              onClick={() => move(i, 1)}
              disabled={i === options.length - 1}
              className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
              title="Down"
            >
              <ChevronDown size={14} />
            </button>
            <button
              onClick={() => remove(i)}
              className="p-1 text-red-400 hover:text-red-600"
              title="Remove"
            >
              <Trash2 size={14} />
            </button>
          </div>
            <OptionDisableWhenEditor
              rule={o.disabledWhen}
              onChange={(next) => update(i, { disabledWhen: next })}
              allQuestions={allQuestions}
              owningQuestionId={owningQuestionId}
            />
          </div>
        ))}
      </div>
      <button
        onClick={add}
        className="mt-2 text-xs font-semibold text-blue-700 hover:text-blue-900 flex items-center gap-1"
      >
        <Plus size={12} /> Add option
      </button>
      <label className="flex items-center gap-2 text-xs text-slate-700 mt-3">
            <input
              type="checkbox"
          checked={allowOther}
          onChange={(e) => onChange(options, e.target.checked)}
        />
        Add "Other / specify" option
      </label>
          </div>
  );
};

const MatrixEditor: React.FC<{
  rows: string[];
  columns: string[];
  onRowsChange: (rows: string[]) => void;
  onColumnsChange: (cols: string[]) => void;
}> = ({ rows, columns, onRowsChange, onColumnsChange }) => {
  const RowsCols: React.FC<{
    label: string;
    values: string[];
    onChange: (next: string[]) => void;
  }> = ({ label, values, onChange }) => (
    <div className="mb-4">
      <label className="block text-xs font-semibold text-slate-700 mb-1">{label}</label>
      {values.map((v, i) => (
        <div key={i} className="flex gap-1 mb-1">
          <input
            type="text"
            value={v}
            onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.value : x)))}
            className="flex-1 text-sm px-2 py-1 border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
                  <button
            onClick={() => onChange(values.filter((_, j) => j !== i))}
            className="p-1 text-red-400 hover:text-red-600"
                  >
            <Trash2 size={14} />
                  </button>
        </div>
      ))}
      <button
        onClick={() => onChange([...values, `${label.replace(/s$/, '')} ${values.length + 1}`])}
        className="text-xs font-semibold text-blue-700 hover:text-blue-900 flex items-center gap-1"
      >
        <Plus size={12} /> Add {label.toLowerCase().replace(/s$/, '')}
      </button>
    </div>
  );

  return (
    <>
      <RowsCols label="Rows" values={rows} onChange={onRowsChange} />
      <RowsCols label="Columns" values={columns} onChange={onColumnsChange} />
    </>
  );
};

// ===========================================================================
// ValidationPanel — right panel "Validation" tab
// ===========================================================================

const ValidationPanel: React.FC<{
  question: Question;
  onUpdate: (patch: Partial<Question>) => void;
}> = ({ question, onUpdate }) => {
  const v = question.validation || {};
  const set = (patch: Partial<QuestionValidation>) =>
    onUpdate({ validation: { ...v, ...patch } });

  return (
    <div>
      {(question.type === 'number' || question.type === 'rating' || question.type === 'scale') && (
        <>
          <Field label="Minimum value">
            <input
              type="number"
              value={v.min ?? ''}
              onChange={(e) => set({ min: e.target.value === '' ? undefined : Number(e.target.value) })}
              className={inputCls}
            />
          </Field>
          <Field label="Maximum value">
            <input
              type="number"
              value={v.max ?? ''}
              onChange={(e) => set({ max: e.target.value === '' ? undefined : Number(e.target.value) })}
              className={inputCls}
            />
          </Field>
          {question.type === 'number' && (
            <>
              <Field label="Step">
                <input
                  type="number"
                  value={v.step ?? ''}
                  onChange={(e) =>
                    set({ step: e.target.value === '' ? undefined : Number(e.target.value) })
                  }
                  className={inputCls}
                  placeholder="1"
                />
              </Field>
              <Field label="Integer only">
                <label className="flex items-center gap-2 text-xs text-slate-700">
                  <input
                    type="checkbox"
                    checked={v.integerOnly || false}
                    onChange={(e) => set({ integerOnly: e.target.checked })}
                  />
                  Reject decimals
                </label>
              </Field>
            </>
          )}
        </>
      )}

      {/* Generic text fields — char-length + custom regex */}
      {(question.type === 'text' || question.type === 'longtext') && (
        <>
          <Field label="Minimum length">
            <input
              type="number"
              value={v.min ?? ''}
              onChange={(e) => set({ min: e.target.value === '' ? undefined : Number(e.target.value) })}
              className={inputCls}
            />
          </Field>
          <Field label="Maximum length">
            <input
              type="number"
              value={v.max ?? ''}
              onChange={(e) => set({ max: e.target.value === '' ? undefined : Number(e.target.value) })}
              className={inputCls}
            />
          </Field>
          <Field
            label="Regex pattern"
            hint="Optional. Example: ^[A-Za-z ]+$ for letters and spaces only."
          >
            <input
              type="text"
              value={v.pattern ?? ''}
              onChange={(e) => set({ pattern: e.target.value || undefined })}
              className={inputCls}
              placeholder="e.g. ^[A-Za-z ]+$"
            />
          </Field>
        </>
      )}

      {/* Email — proper email format is enforced automatically. The
          regex / length fields are still exposed as advanced overrides
          for surveys that need stricter rules (e.g. only @gov.bd addresses). */}
      {question.type === 'email' && (
        <>
          <div className="text-[11px] text-slate-600 bg-blue-50 border border-blue-100 rounded-md px-2.5 py-2 mb-3 leading-snug">
            <span className="font-semibold text-blue-700">Auto-validated</span>: every
            answer must contain <span className="font-mono">@</span> and a valid
            domain (e.g. <span className="font-mono">name@example.com</span>) — no
            extra rules needed.
          </div>
          <Field
            label="Regex override (optional)"
            hint="Set a stricter pattern if you need to limit accepted addresses, e.g. ^[a-z.]+@yourorg\\.bd$"
          >
            <input
              type="text"
              value={v.pattern ?? ''}
              onChange={(e) => set({ pattern: e.target.value || undefined })}
              className={inputCls}
              placeholder="(leave blank for default email check)"
            />
          </Field>
        </>
      )}

      {/* Phone — digit-count rules. Spaces / hyphens / `+` / parens are
          stripped before counting so admins can think in "11 digits"
          instead of "13 characters including the +880 prefix". Exact
          digits takes precedence over min/max. */}
      {question.type === 'phone' && (
        <>
          <div className="text-[11px] text-slate-600 bg-blue-50 border border-blue-100 rounded-md px-2.5 py-2 mb-3 leading-snug">
            Counts only digits — formatting characters like{' '}
            <span className="font-mono">+</span>, spaces, and hyphens are
            ignored. Use <span className="font-semibold">Total digits</span> for
            exact-length numbers (most common for national mobile formats).
          </div>
          <Field
            label="Total digits (exact)"
            hint="E.g. 11 for Bangladesh mobile (01712345678). Overrides min/max when set."
          >
            <input
              type="number"
              min={1}
              value={v.digits ?? ''}
              onChange={(e) =>
                set({ digits: e.target.value === '' ? undefined : Number(e.target.value) })
              }
              className={inputCls}
              placeholder="e.g. 11"
            />
          </Field>
          <Field label="Min digits">
            <input
              type="number"
              min={1}
              value={v.min ?? ''}
              onChange={(e) => set({ min: e.target.value === '' ? undefined : Number(e.target.value) })}
              className={inputCls}
              placeholder="(any)"
              disabled={v.digits !== undefined}
            />
          </Field>
          <Field label="Max digits">
            <input
              type="number"
              min={1}
              value={v.max ?? ''}
              onChange={(e) => set({ max: e.target.value === '' ? undefined : Number(e.target.value) })}
              className={inputCls}
              placeholder="(any)"
              disabled={v.digits !== undefined}
            />
          </Field>
          <Field
            label="Regex override (optional)"
            hint="Use only when you need a strict format beyond digit count, e.g. ^\\+880[0-9]{10}$"
          >
            <input
              type="text"
              value={v.pattern ?? ''}
              onChange={(e) => set({ pattern: e.target.value || undefined })}
              className={inputCls}
              placeholder="(leave blank for digit-count check)"
            />
          </Field>
        </>
      )}

      {(question.type === 'date' || question.type === 'datetime') && (
        <>
          <Field label="Earliest date">
            <input
              type="date"
              value={v.minDate || ''}
              onChange={(e) => set({ minDate: e.target.value || undefined })}
              className={inputCls}
            />
          </Field>
          <Field label="Latest date">
            <input
              type="date"
              value={v.maxDate || ''}
              onChange={(e) => set({ maxDate: e.target.value || undefined })}
              className={inputCls}
            />
          </Field>
        </>
      )}

      {(question.type === 'multiselect' || question.type === 'checkbox') && (
        <>
          <Field label="Min selections">
            <input
              type="number"
              value={v.minSelections ?? ''}
              onChange={(e) =>
                set({
                  minSelections: e.target.value === '' ? undefined : Number(e.target.value)
                })
              }
              className={inputCls}
            />
          </Field>
          <Field label="Max selections">
            <input
              type="number"
              value={v.maxSelections ?? ''}
              onChange={(e) =>
                set({
                  maxSelections: e.target.value === '' ? undefined : Number(e.target.value)
                })
              }
              className={inputCls}
            />
          </Field>
        </>
      )}

      <Field label="Custom error message" hint="Shown when validation fails.">
        <input
          type="text"
          value={v.errorMessage ?? ''}
          onChange={(e) => set({ errorMessage: e.target.value || undefined })}
          className={inputCls}
          placeholder="Please provide a valid answer."
        />
      </Field>
    </div>
  );
};

// ===========================================================================
// LogicPanel — right panel "Logic" tab (conditional show/hide)
// ===========================================================================

const OPERATORS: { value: LogicOperator; label: string; takesValue: boolean }[] = [
  { value: 'equals',       label: 'equals',         takesValue: true  },
  { value: 'notEquals',    label: 'does not equal', takesValue: true  },
  { value: 'contains',     label: 'contains',       takesValue: true  },
  { value: 'notContains',  label: 'does not contain', takesValue: true },
  { value: 'greaterThan',  label: 'is greater than', takesValue: true },
  { value: 'lessThan',     label: 'is less than',    takesValue: true },
  { value: 'isEmpty',      label: 'is empty',        takesValue: false },
  { value: 'isNotEmpty',   label: 'is not empty',    takesValue: false }
];

const LogicPanel: React.FC<{
  question: Question;
  allQuestions: Question[];
  onUpdate: (patch: Partial<Question>) => void;
}> = ({ question, allQuestions, onUpdate }) => {
  const logic: LogicRule = question.logic || blankLogic();

  const setLogic = (patch: Partial<LogicRule>) => onUpdate({ logic: { ...logic, ...patch } });

  const referenceable = allQuestions.filter(
    (q) => q.id !== question.id && q.type !== 'section'
  );

  const addCondition = () => {
    const first = referenceable[0];
    if (!first) {
      alert('Add another question first to reference it in logic.');
      return;
    }
    const cond: LogicCondition = {
      id: uid('c'),
      questionId: first.id,
      operator: 'equals',
      value: ''
    };
    setLogic({ conditions: [...logic.conditions, cond] });
  };

  const updateCond = (id: string, patch: Partial<LogicCondition>) => {
    setLogic({
      conditions: logic.conditions.map((c) => (c.id === id ? { ...c, ...patch } : c))
    });
  };

  const removeCond = (id: string) =>
    setLogic({ conditions: logic.conditions.filter((c) => c.id !== id) });

  return (
    <div>
      <Field
        label="Display logic"
        hint="Show this question only when the rules below match."
      >
        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            checked={logic.enabled}
            onChange={(e) => setLogic({ enabled: e.target.checked })}
          />
          Enable conditional display
        </label>
      </Field>

      {logic.enabled && (
        <>
          <Field label="Match">
            <div className="inline-flex rounded-md border border-slate-200 overflow-hidden">
              {(['AND', 'OR'] as const).map((c) => (
            <button
                  key={c}
                  onClick={() => setLogic({ combinator: c })}
                  className={`px-3 py-1 text-xs font-bold ${
                    logic.combinator === c
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {c === 'AND' ? 'All (AND)' : 'Any (OR)'}
            </button>
              ))}
          </div>
          </Field>

          <div className="space-y-2 mb-2">
            {logic.conditions.length === 0 && (
              <div className="text-xs text-slate-400 italic">
                No conditions yet. Add one below.
              </div>
            )}
            {logic.conditions.map((cond) => {
              const refQ = allQuestions.find((q) => q.id === cond.questionId);
              const opDef = OPERATORS.find((o) => o.value === cond.operator);
              const refOpts = refQ ? ensureOptionShape(refQ.options) : [];
              return (
                <div
                  key={cond.id}
                  className="border border-slate-200 rounded-md p-2 bg-slate-50 space-y-1"
                >
                  <div className="flex items-center gap-1">
                    <select
                      value={cond.questionId}
                      onChange={(e) => updateCond(cond.id, { questionId: e.target.value })}
                      className="flex-1 text-xs px-1.5 py-1 border border-slate-200 rounded bg-white"
                    >
                      {referenceable.map((q) => (
                        <option key={q.id} value={q.id}>
                          {q.question.slice(0, 40) || `(unnamed) ${q.id}`}
                        </option>
                      ))}
                    </select>
                  <button
                      onClick={() => removeCond(cond.id)}
                      className="p-1 text-red-400 hover:text-red-600"
                  >
                      <Trash2 size={13} />
                  </button>
                  </div>
                  <select
                    value={cond.operator}
                    onChange={(e) =>
                      updateCond(cond.id, { operator: e.target.value as LogicOperator })
                    }
                    className="w-full text-xs px-1.5 py-1 border border-slate-200 rounded bg-white"
                  >
                    {OPERATORS.map((op) => (
                      <option key={op.value} value={op.value}>
                        {op.label}
                      </option>
                    ))}
                  </select>
                  {opDef?.takesValue && (
                    <>
                      {refQ && isChoiceType(refQ.type) ? (
                        <select
                          value={cond.value || ''}
                          onChange={(e) => updateCond(cond.id, { value: e.target.value })}
                          className="w-full text-xs px-1.5 py-1 border border-slate-200 rounded bg-white"
                        >
                          <option value="">— select value —</option>
                          {refOpts.map((o) => (
                            <option key={o.id} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={cond.value || ''}
                          onChange={(e) => updateCond(cond.id, { value: e.target.value })}
                          className="w-full text-xs px-1.5 py-1 border border-slate-200 rounded bg-white"
                          placeholder="Value"
                        />
                      )}
                    </>
                  )}
                </div>
              );
            })}
                </div>

          <button
            onClick={addCondition}
            className="text-xs font-semibold text-blue-700 hover:text-blue-900 flex items-center gap-1"
          >
            <Plus size={12} /> Add condition
          </button>
        </>
      )}

      {/* Divider between the two related-but-distinct rule families:
          "Display logic" decides whether the question is visible at all,
          "Default value rules" decides what the answer should be when
          the question is visible. Both live in the same tab so admins
          discover them together. */}
      <div className="mt-5 pt-5 border-t border-slate-200">
        <DefaultRulesPanel
          question={question}
          allQuestions={allQuestions}
          onUpdate={onUpdate}
        />
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// DefaultRulesPanel — companion to LogicPanel. Lets admins author
// conditional auto-fill rules: "when [other answers] match, set this
// question's value to X (and optionally lock it)". Each rule reuses the
// same LogicCondition + AND/OR machinery as the visibility logic, so
// admins only need to learn one rule-builder vocabulary.
// ---------------------------------------------------------------------------

const VALUE_RULE_MODE_LABELS: Record<ValueRuleMode, { label: string; hint: string }> = {
  fillIfEmpty: {
    label: 'Auto-fill (if empty)',
    hint: 'Sets the answer only if the enumerator hasn\'t entered anything. They can still type over it.'
  },
  lock: {
    label: 'Lock to value',
    hint: 'Forces the answer to this value and disables the input while the condition matches.'
  }
};

const DefaultRulesPanel: React.FC<{
  question: Question;
  allQuestions: Question[];
  onUpdate: (patch: Partial<Question>) => void;
}> = ({ question, allQuestions, onUpdate }) => {
  const rules = question.defaultValueRules ?? [];

  // Section dividers and `location`/`signature`/`file` types don't have a
  // value the admin can sensibly type — surfacing the panel for them
  // would only confuse. Locking the location capture, for example,
  // would defeat the whole point of capturing GPS in the first place.
  const valueTypeIsAuthorable = !['section', 'location', 'signature', 'file', 'photo'].includes(
    question.type
  );

  const referenceable = allQuestions.filter(
    (q) => q.id !== question.id && q.type !== 'section'
  );

  const setRules = (next: DefaultValueRule[]) =>
    onUpdate({ defaultValueRules: next });

  const addRule = () => {
    if (referenceable.length === 0) {
      alert('Add another question first to reference it in default-value rules.');
      return;
    }
    const newRule: DefaultValueRule = {
      id: uid('dvr'),
      mode: 'fillIfEmpty',
      value: '',
      when: {
        enabled: true,
        combinator: 'AND',
        conditions: [
          {
            id: uid('c'),
            questionId: referenceable[0].id,
            operator: 'equals',
            value: ''
          }
        ]
      }
    };
    setRules([...rules, newRule]);
  };

  const updateRule = (id: string, patch: Partial<DefaultValueRule>) =>
    setRules(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const removeRule = (id: string) => setRules(rules.filter((r) => r.id !== id));

  const updateRuleCond = (
    ruleId: string,
    condId: string,
    patch: Partial<LogicCondition>
  ) => {
    setRules(
      rules.map((r) =>
        r.id === ruleId
          ? {
              ...r,
              when: {
                ...r.when,
                conditions: r.when.conditions.map((c) =>
                  c.id === condId ? { ...c, ...patch } : c
                )
              }
            }
          : r
      )
    );
  };

  const addRuleCond = (ruleId: string) => {
    const first = referenceable[0];
    if (!first) return;
    setRules(
      rules.map((r) =>
        r.id === ruleId
          ? {
              ...r,
              when: {
                ...r.when,
                conditions: [
                  ...r.when.conditions,
                  { id: uid('c'), questionId: first.id, operator: 'equals', value: '' }
                ]
              }
            }
          : r
      )
    );
  };

  const removeRuleCond = (ruleId: string, condId: string) => {
    setRules(
      rules.map((r) =>
        r.id === ruleId
          ? {
              ...r,
              when: {
                ...r.when,
                conditions: r.when.conditions.filter((c) => c.id !== condId)
              }
            }
          : r
      )
    );
  };

  // Choice-type questions need a dropdown of their own options for the
  // value picker; everything else uses a free-text/number input.
  const ownOptions = ensureOptionShape(question.options);
  const renderValueInput = (rule: DefaultValueRule) => {
    if (isChoiceType(question.type) && question.type !== 'multiselect' && question.type !== 'checkbox') {
      return (
        <select
          value={rule.value || ''}
          onChange={(e) => updateRule(rule.id, { value: e.target.value })}
          className="w-full text-xs px-1.5 py-1 border border-slate-200 rounded bg-white"
        >
          <option value="">— select value —</option>
          {ownOptions.map((o) => (
            <option key={o.id} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    if (question.type === 'multiselect' || question.type === 'checkbox') {
      // Multi-select: comma-separated list of option values. We render a
      // checkbox group so admins don't have to remember exact value
      // strings.
      const selected = new Set(
        (rule.value || '').split(',').map((s) => s.trim()).filter(Boolean)
      );
      return (
        <div className="flex flex-col gap-1 border border-slate-200 rounded bg-white px-2 py-1.5 max-h-40 overflow-y-auto">
          {ownOptions.length === 0 && (
            <span className="text-[10px] text-slate-400 italic">
              Add options to this question first.
            </span>
          )}
          {ownOptions.map((o) => {
            const checked = selected.has(o.value);
            return (
              <label key={o.id} className="flex items-center gap-1.5 text-[11px] cursor-pointer">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(o.value);
                    else next.delete(o.value);
                    updateRule(rule.id, { value: Array.from(next).join(',') });
                  }}
                />
                <span>{o.label}</span>
              </label>
            );
          })}
        </div>
      );
    }
    if (question.type === 'number') {
      return (
        <input
          type="number"
          value={rule.value || ''}
          onChange={(e) => updateRule(rule.id, { value: e.target.value })}
          className="w-full text-xs px-1.5 py-1 border border-slate-200 rounded bg-white"
          placeholder="Numeric value"
        />
      );
    }
    if (question.type === 'age') {
      // For age, the rule value is stored as a `years,months` string —
      // surface a two-input editor so admins don't have to remember the
      // format. `0,6` would mean "six months old" when applied.
      const parts = (rule.value || '').split(/[,\s/]+/).filter(Boolean);
      const yrs = parts[0] ?? '';
      const mos = parts[1] ?? '';
      const commit = (ny: string, nm: string) => {
        const yClean = ny.trim();
        const mClean = nm.trim();
        if (yClean === '' && mClean === '') {
          updateRule(rule.id, { value: '' });
          return;
        }
        updateRule(rule.id, { value: `${yClean || 0},${mClean || 0}` });
      };
      return (
        <div className="flex gap-1.5">
          <div className="flex-1 min-w-0 relative">
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={150}
              step={1}
              value={yrs}
              onChange={(e) => commit(e.target.value, mos)}
              placeholder="0"
              className="w-full text-xs px-1.5 py-1 pr-9 border border-slate-200 rounded bg-white"
            />
            <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] font-semibold text-slate-400 uppercase">
              yrs
            </span>
          </div>
          <div className="flex-1 min-w-0 relative">
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={11}
              step={1}
              value={mos}
              onChange={(e) => commit(yrs, e.target.value)}
              placeholder="0"
              className="w-full text-xs px-1.5 py-1 pr-9 border border-slate-200 rounded bg-white"
            />
            <span className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-[9px] font-semibold text-slate-400 uppercase">
              mos
            </span>
          </div>
        </div>
      );
    }
    return (
      <input
        type={
          question.type === 'date'
            ? 'date'
            : question.type === 'time'
              ? 'time'
              : question.type === 'datetime'
                ? 'datetime-local'
                : 'text'
        }
        value={rule.value || ''}
        onChange={(e) => updateRule(rule.id, { value: e.target.value })}
        className="w-full text-xs px-1.5 py-1 border border-slate-200 rounded bg-white"
        placeholder="Value"
      />
    );
  };

  return (
    <div>
      <Field
        label="Default value rules"
        hint="Auto-fill or lock this answer based on other answers. First matching rule wins."
      >
        {!valueTypeIsAuthorable ? (
          <p className="text-[11px] text-slate-400 italic">
            Default-value rules don't apply to {question.type} questions.
          </p>
        ) : referenceable.length === 0 ? (
          <p className="text-[11px] text-slate-400 italic">
            Add another question first to reference it in a rule.
          </p>
        ) : (
          <>
            {rules.length === 0 && (
              <p className="text-[11px] text-slate-400 italic mb-2">
                No rules yet. Click <span className="font-semibold">Add rule</span> to create one.
              </p>
            )}

            <div className="space-y-3 mb-2">
              {rules.map((rule, ruleIdx) => (
                <div
                  key={rule.id}
                  className="border border-slate-200 rounded-md bg-amber-50/40 p-2.5 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-bold text-amber-800 uppercase tracking-wider">
                      Rule {ruleIdx + 1}
                    </span>
                    <button
                      onClick={() => removeRule(rule.id)}
                      className="p-1 text-red-400 hover:text-red-600"
                      title="Delete rule"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>

                  {/* Condition group — same UI shape as the visibility-
                      logic conditions for consistency. */}
                  <div>
                    <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                      When (
                      <button
                        type="button"
                        onClick={() =>
                          updateRule(rule.id, {
                            when: {
                              ...rule.when,
                              combinator: rule.when.combinator === 'AND' ? 'OR' : 'AND'
                            }
                          })
                        }
                        className="font-bold text-blue-700 hover:underline mx-0.5"
                      >
                        {rule.when.combinator === 'AND' ? 'all' : 'any'}
                      </button>
                      of these match)
                    </div>
                    <div className="space-y-1.5">
                      {rule.when.conditions.map((cond) => {
                        const refQ = allQuestions.find((q) => q.id === cond.questionId);
                        const opDef = OPERATORS.find((o) => o.value === cond.operator);
                        const refOpts = refQ ? ensureOptionShape(refQ.options) : [];
                        return (
                          <div
                            key={cond.id}
                            className="border border-slate-200 rounded-md p-2 bg-white space-y-1"
                          >
                            <div className="flex items-center gap-1">
                              <select
                                value={cond.questionId}
                                onChange={(e) =>
                                  updateRuleCond(rule.id, cond.id, {
                                    questionId: e.target.value
                                  })
                                }
                                className="flex-1 text-xs px-1.5 py-1 border border-slate-200 rounded bg-white"
                              >
                                {referenceable.map((q) => (
                                  <option key={q.id} value={q.id}>
                                    {q.question.slice(0, 40) || `(unnamed) ${q.id}`}
                                  </option>
                                ))}
                              </select>
                              {rule.when.conditions.length > 1 && (
                                <button
                                  onClick={() => removeRuleCond(rule.id, cond.id)}
                                  className="p-1 text-red-400 hover:text-red-600"
                                  title="Remove condition"
                                >
                                  <Trash2 size={12} />
                                </button>
                              )}
                            </div>
                            <select
                              value={cond.operator}
                              onChange={(e) =>
                                updateRuleCond(rule.id, cond.id, {
                                  operator: e.target.value as LogicOperator
                                })
                              }
                              className="w-full text-xs px-1.5 py-1 border border-slate-200 rounded bg-white"
                            >
                              {OPERATORS.map((op) => (
                                <option key={op.value} value={op.value}>
                                  {op.label}
                                </option>
                              ))}
                            </select>
                            {opDef?.takesValue && (
                              <>
                                {refQ && isChoiceType(refQ.type) ? (
                                  <select
                                    value={cond.value || ''}
                                    onChange={(e) =>
                                      updateRuleCond(rule.id, cond.id, {
                                        value: e.target.value
                                      })
                                    }
                                    className="w-full text-xs px-1.5 py-1 border border-slate-200 rounded bg-white"
                                  >
                                    <option value="">— select value —</option>
                                    {refOpts.map((o) => (
                                      <option key={o.id} value={o.value}>
                                        {o.label}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                  <input
                    type="text"
                                    value={cond.value || ''}
                                    onChange={(e) =>
                                      updateRuleCond(rule.id, cond.id, {
                                        value: e.target.value
                                      })
                                    }
                                    className="w-full text-xs px-1.5 py-1 border border-slate-200 rounded bg-white"
                                    placeholder="Value"
                                  />
                                )}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <button
                      onClick={() => addRuleCond(rule.id)}
                      className="text-[10px] font-semibold text-blue-700 hover:text-blue-900 flex items-center gap-1 mt-1.5"
                    >
                      <Plus size={11} /> Add condition
                    </button>
                  </div>

                  {/* Mode + value */}
                  <div>
                    <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1">
                      Then
                    </div>
                    <div className="space-y-1.5">
                    <select
                        value={rule.mode}
                        onChange={(e) =>
                          updateRule(rule.id, { mode: e.target.value as ValueRuleMode })
                        }
                        className="w-full text-xs px-1.5 py-1 border border-slate-200 rounded bg-white"
                        title={VALUE_RULE_MODE_LABELS[rule.mode].hint}
                      >
                        {(Object.keys(VALUE_RULE_MODE_LABELS) as ValueRuleMode[]).map((m) => (
                          <option key={m} value={m}>
                            {VALUE_RULE_MODE_LABELS[m].label}
                          </option>
                        ))}
                    </select>
                      <p className="text-[10px] text-slate-500 leading-snug">
                        {VALUE_RULE_MODE_LABELS[rule.mode].hint}
                      </p>
                      {renderValueInput(rule)}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={addRule}
              className="text-xs font-semibold text-blue-700 hover:text-blue-900 flex items-center gap-1"
            >
              <Plus size={12} /> Add rule
            </button>
          </>
        )}
      </Field>
    </div>
  );
};

// ===========================================================================
// Settings dialog
// ===========================================================================

const SettingsDialog: React.FC<{
  version: string;
  onVersionChange: (v: string) => void;
  isActive: boolean;
  onIsActiveChange: (v: boolean) => void;
  settings: QuestionnaireSettings;
  onSettingsChange: (s: QuestionnaireSettings) => void;
  onClose: () => void;
}> = ({
  version,
  onVersionChange,
  isActive,
  onIsActiveChange,
  settings,
  onSettingsChange,
  onClose
}) => {
  const Toggle: React.FC<{
    label: string;
    hint: string;
    checked: boolean;
    onChange: (v: boolean) => void;
  }> = ({ label, hint, checked, onChange }) => (
    <label className="flex items-start gap-2 py-2 border-b border-slate-100 last:border-0 cursor-pointer">
                      <input
                        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <div className="flex-1">
        <div className="text-sm font-semibold text-slate-800">{label}</div>
        <div className="text-xs text-slate-500">{hint}</div>
      </div>
                    </label>
  );

  return (
    <div className="fixed inset-0 z-[1010] bg-slate-900/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
          <h3 className="font-bold text-slate-900 flex items-center gap-2">
            <Settings size={18} /> Questionnaire Settings
          </h3>
          <button onClick={onClose} className="p-1 text-slate-500 hover:bg-slate-100 rounded">
            <X size={18} />
          </button>
                  </div>
        <div className="p-5">
          <Field label="Version">
                  <input
                    type="text"
              value={version}
              onChange={(e) => onVersionChange(e.target.value)}
              className={inputCls}
              placeholder="1.0"
            />
          </Field>
          <Field label="Active">
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => onIsActiveChange(e.target.checked)}
              />
              Available to enumerators (otherwise saved as draft)
            </label>
          </Field>
          <div className="mt-4 mb-2 text-xs font-bold text-slate-500 uppercase tracking-wider">
            Behavior
          </div>
          <Toggle
            label="Show progress bar"
            hint="Display completion progress as the respondent advances."
            checked={settings.showProgress || false}
            onChange={(v) => onSettingsChange({ ...settings, showProgress: v })}
          />
          <Toggle
            label="Allow draft save"
            hint="Respondents can save and resume an unfinished survey."
            checked={settings.allowSaveDraft || false}
            onChange={(v) => onSettingsChange({ ...settings, allowSaveDraft: v })}
          />
          <Toggle
            label="One section per page"
            hint="Break the survey into pages by section."
            checked={settings.paginated || false}
            onChange={(v) => onSettingsChange({ ...settings, paginated: v })}
          />
          <Toggle
            label="Auto-capture location"
            hint="Attach GPS coordinates when a response is submitted."
            checked={settings.captureLocation || false}
            onChange={(v) => onSettingsChange({ ...settings, captureLocation: v })}
          />
          <Toggle
            label="Shuffle questions"
            hint="Randomise the order of questions within each section."
            checked={settings.shuffleQuestions || false}
            onChange={(v) => onSettingsChange({ ...settings, shuffleQuestions: v })}
          />
        </div>
        <div className="px-5 py-3 border-t border-slate-200 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

// ===========================================================================
// Preview dialog — renders the questionnaire as a respondent would see it
// ===========================================================================

const evaluateLogic = (
  logic: LogicRule | undefined,
  answers: Record<string, unknown>
): boolean => {
  if (!logic || !logic.enabled || logic.conditions.length === 0) return true;
  const results = logic.conditions.map((c) => {
    const a = answers[c.questionId];
    const v = c.value ?? '';
    switch (c.operator) {
      case 'equals':
        return choiceAnswerToComparableString(a) === String(v);
      case 'notEquals':
        return choiceAnswerToComparableString(a) !== String(v);
      case 'contains':
        if (Array.isArray(a)) return a.includes(v);
        return choiceAnswerToComparableString(a)
          .toLowerCase()
          .includes(String(v).toLowerCase());
      case 'notContains':
        if (Array.isArray(a)) return !a.includes(v);
        return !choiceAnswerToComparableString(a)
          .toLowerCase()
          .includes(String(v).toLowerCase());
      case 'greaterThan':
        return Number(a) > Number(v);
      case 'lessThan':
        return Number(a) < Number(v);
      case 'isEmpty':
        return choiceAnswerIsLogicallyEmpty(a);
      case 'isNotEmpty':
        return !choiceAnswerIsLogicallyEmpty(a);
      default:
        return true;
    }
  });
  return logic.combinator === 'AND' ? results.every(Boolean) : results.some(Boolean);
};

// Local mirror of the runtime helpers — kept here so the builder bundle
// doesn't have to import the runtime module (which would shift its
// code-split chunk and partially defeat the lazy load on the enumerator
// side). Logic is identical to `QuestionnaireRuntime.computeAppliedDefaultRules`
// / `ruleValueMatchesCurrent`; if you change one, change the other.
const coerceRuleValueLocal = (raw: string, target: Question): unknown => {
  switch (target.type) {
    case 'number':
      if (raw === '') return '';
      return Number.isFinite(Number(raw)) ? Number(raw) : raw;
    case 'age': {
      // Accept "Y" or "Y,M" or "Y M" so admins can author defaults like
      // "0,6" (six months old) or "5" (exactly five years).
      if (!raw.trim()) return '';
      const parts = raw.split(/[,\s/]+/).filter(Boolean);
      const y = Number(parts[0] ?? 0);
      const m = Number(parts[1] ?? 0);
      const yy = Number.isFinite(y) ? Math.max(0, Math.floor(y)) : 0;
      const mm = Number.isFinite(m) ? Math.min(11, Math.max(0, Math.floor(m))) : 0;
      return { years: yy, months: mm, totalMonths: yy * 12 + mm };
    }
    case 'checkbox':
    case 'multiselect':
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    default:
      return raw;
  }
};

interface AppliedDefaultRuleLocal {
  questionId: string;
  ruleId: string;
  mode: ValueRuleMode;
  value: unknown;
}

const computeAppliedDefaultRules = (
  questions: Question[],
  answers: Record<string, unknown>
): AppliedDefaultRuleLocal[] => {
  const out: AppliedDefaultRuleLocal[] = [];
  for (const q of questions) {
    const rules = q.defaultValueRules;
    if (!rules || rules.length === 0) continue;
    for (const rule of rules) {
      if (!rule.when?.enabled || rule.when.conditions.length === 0) continue;
      if (evaluateLogic(rule.when, answers)) {
        out.push({
          questionId: q.id,
          ruleId: rule.id,
          mode: rule.mode,
          value: coerceRuleValueLocal(rule.value ?? '', q)
        });
        break;
      }
    }
  }
  return out;
};

const ruleValueMatchesCurrent = (current: unknown, target: unknown): boolean => {
  if (Array.isArray(current) && Array.isArray(target)) {
    if (current.length !== target.length) return false;
    return current.every((v, i) => v === target[i]);
  }
  return choiceAnswerToComparableString(current) === choiceAnswerToComparableString(target);
};

const PreviewDialog: React.FC<{
  title: string;
  descriptionBlocks: DescriptionBlock[];
  conclusionBlocks: DescriptionBlock[];
  enumeratorInfo: EnumeratorInfo;
  consentGate: ConsentGate;
  submissionGps: SubmissionGpsCapture;
  version: string;
  questions: Question[];
  settings: QuestionnaireSettings;
  onClose: () => void;
}> = ({
  title,
  descriptionBlocks,
  conclusionBlocks,
  enumeratorInfo,
  consentGate,
  submissionGps,
  version,
  questions,
  settings,
  onClose
}) => {
  const { user, userProfile } = useAuth();
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [enumeratorAnswers, setEnumeratorAnswers] = useState<Record<string, unknown>>({});
  const [consentGranted, setConsentGranted] = useState(false);
  /** Questions are revealed only when the gate is disabled or has been accepted. */
  const questionsUnlocked = !consentGate.enabled || consentGranted;

  const visibleQuestions = questions.filter((q) => evaluateLogic(q.logic, answers));

  // Mirror the live form's auto-fill / lock behaviour so admins testing
  // rules in preview see the same outcome enumerators will. Same loop-
  // safety guards (no-op when the patch matches current state).
  const appliedDefaultRules = useMemo(
    () => computeAppliedDefaultRules(visibleQuestions, answers),
    [visibleQuestions, answers]
  );
  const lockedQuestionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of appliedDefaultRules) {
      if (r.mode === 'lock') ids.add(r.questionId);
    }
    return ids;
  }, [appliedDefaultRules]);

  const previewLogicAnswers = useMemo(
    () => ({ ...enumeratorAnswers, ...answers }),
    [enumeratorAnswers, answers]
  );

  useEffect(() => {
    if (appliedDefaultRules.length === 0) return;
    const patch: Record<string, unknown> = {};
    for (const r of appliedDefaultRules) {
      const current = answers[r.questionId];
      if (r.mode === 'lock') {
        if (!ruleValueMatchesCurrent(current, r.value)) patch[r.questionId] = r.value;
      } else if (
        current === undefined ||
        current === null ||
        current === '' ||
        (Array.isArray(current) && current.length === 0)
      ) {
        if (!ruleValueMatchesCurrent(current, r.value)) patch[r.questionId] = r.value;
      }
    }
    if (Object.keys(patch).length > 0) setAnswers((prev) => ({ ...prev, ...patch }));
  }, [appliedDefaultRules, answers]);

  const totalRequired = visibleQuestions.filter((q) => q.required && q.type !== 'section').length;
  const answered = visibleQuestions.filter((q) => {
    if (!q.required || q.type === 'section') return false;
    const v = answers[q.id];
    if (q.type === 'matrix') return matrixAllRowsAnswered(v, q.rows);
    return (
      v !== undefined &&
      v !== '' &&
      !(Array.isArray(v) && (v as unknown[]).length === 0)
    );
  }).length;
  // Until consent is granted, progress stays at 0% to make the gate state obvious.
  const progress = !questionsUnlocked
    ? 0
    : totalRequired
      ? Math.round((answered / totalRequired) * 100)
      : 0;

  return (
    <div className="fixed inset-0 z-[1010] bg-slate-900/60 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-gradient-to-r from-blue-50 to-indigo-50 rounded-t-xl">
                    <div>
            <div className="flex items-center gap-2 text-[10px] font-bold text-blue-700 uppercase tracking-wider mb-1">
              <Eye size={12} /> Preview mode
            </div>
            <h3 className="font-bold text-slate-900">{title || 'Untitled Questionnaire'}</h3>
            <p className="text-xs text-slate-500">
              v{version || '1.0'} • {visibleQuestions.length} visible questions
            </p>
          </div>
          <button onClick={onClose} className="p-1 text-slate-500 hover:bg-white/60 rounded">
            <X size={20} />
          </button>
        </div>

        {settings.showProgress && (
          <div className="px-6 py-2 border-b border-slate-100 bg-white">
            <div className="flex justify-between text-[10px] font-semibold text-slate-500 mb-1">
              <span>Progress</span>
              <span>{progress}%</span>
            </div>
            <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div className="h-full bg-blue-600" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {descriptionBlocks.length > 0 && (
            <div className="border-b border-slate-100 pb-4">
              <DescriptionRenderer blocks={descriptionBlocks} />
            </div>
          )}
          {enumeratorInfo.enabled && enumeratorInfo.fields.length > 0 && (
            <EnumeratorInfoTable
              info={enumeratorInfo}
              answers={enumeratorAnswers}
              logicAnswers={previewLogicAnswers}
              onChange={(id, v) => setEnumeratorAnswers((prev) => ({ ...prev, [id]: v }))}
            />
          )}
          {consentGate.enabled && (
            <ConsentGateForm
              gate={consentGate}
              granted={consentGranted}
              onChange={setConsentGranted}
              enumeratorDisplayName={enumeratorResolvedDisplayName(userProfile, user)}
            />
          )}
          {!questionsUnlocked ? (
            <div className="flex items-center justify-center gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
              <Lock size={16} />
              Tick the consent checkbox to start the survey.
            </div>
          ) : (
            <>
              {visibleQuestions.length === 0 ? (
                <p className="text-sm text-slate-500 italic">Nothing to preview yet.</p>
              ) : (
                (() => {
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
                      <fieldset
                        key={q.id}
                        disabled={locked}
                        className={`${
                          locked
                            ? '[&_input]:cursor-not-allowed [&_select]:cursor-not-allowed [&_textarea]:cursor-not-allowed [&_input:disabled]:bg-slate-50 [&_select:disabled]:bg-slate-50 [&_textarea:disabled]:bg-slate-50 '
                            : ''
                        }${depth > 0 ? 'ml-5 pl-4 border-l-2 border-blue-200' : ''}`}
                      >
                        <PreviewQuestion
                          index={0}
                          numberLabel={q.type === 'section' ? '' : label}
                          question={q}
                          value={answers[q.id]}
                          onChange={(v) => setAnswers((prev) => ({ ...prev, [q.id]: v }))}
                          allAnswers={previewLogicAnswers}
                          allQuestions={visibleQuestions}
                        />
                        {locked && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-1.5 py-0.5 mt-1">
                            Auto-filled (locked by rule)
                          </span>
                        )}
                      </fieldset>
                    );
                  });
                })()
              )}
              {conclusionBlocks.length > 0 && (
                <div className="rounded-lg border border-slate-200 bg-slate-50/80 px-4 py-3 space-y-2">
                  <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                    Conclusion
                  </div>
                  <DescriptionRenderer blocks={conclusionBlocks} />
                </div>
              )}
              {submissionGps.enabled && (
                <SubmissionGpsCaptureWidget
                  config={submissionGps}
                  title={submissionGps.title}
                  description={submissionGps.description}
                />
              )}
            </>
          )}
        </div>

        <div className="px-6 py-3 border-t border-slate-200 bg-slate-50 rounded-b-xl flex items-center justify-between text-xs text-slate-500">
          <span>This is a live preview — answers are not saved.</span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg"
          >
            Close Preview
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * Read-only chip used by both the preview dialog and the live runtime to
 * render a `computed` question's auto-calculated value. We show an
 * explicit "Auto-calculated" badge so enumerators understand they can't
 * type into the field and admins can spot computed columns in QA
 * sessions at a glance.
 */
const ComputedReadOnlyDisplay: React.FC<{
  display: string;
  spec?: ComputedSpec;
}> = ({ display, spec }) => {
  const hasValue = display !== '';
  return (
    <div className="flex flex-col gap-1">
      <div
        className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2 ${
          hasValue
            ? 'border-violet-200 bg-violet-50 text-violet-900'
            : 'border-dashed border-slate-300 bg-slate-50 text-slate-400 italic'
        }`}
      >
        <span className="text-sm font-mono break-all min-w-0">
          {hasValue ? display : 'Waiting for operand answers…'}
        </span>
        <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-violet-700 bg-white border border-violet-200 rounded-full px-1.5 py-0.5 shrink-0">
          <Sigma size={10} /> Auto
        </span>
      </div>
      {spec && spec.operation && (
        <p className="text-[10px] text-slate-400">
          Auto-calculated · {computedOpHumanLabel(spec.operation)}
          {spec.operandQuestionIds && spec.operandQuestionIds.length > 0 &&
            spec.operation !== 'expression' &&
            ` of ${spec.operandQuestionIds.length} operand${
              spec.operandQuestionIds.length === 1 ? '' : 's'
            }`}
        </p>
      )}
    </div>
  );
};

const computedOpHumanLabel = (op: ComputedOperation): string => {
  switch (op) {
    case 'sum':
      return 'Sum';
    case 'subtract':
      return 'Subtract';
    case 'multiply':
      return 'Multiply';
    case 'divide':
      return 'Divide';
    case 'average':
      return 'Average';
    case 'min':
      return 'Minimum';
    case 'max':
      return 'Maximum';
    case 'count_nonempty':
      return 'Count of answered';
    case 'concat':
      return 'Joined text';
    case 'expression':
      return 'Custom formula';
  }
};

const PreviewQuestion: React.FC<{
  index: number;
  numberLabel?: string;
  question: Question;
  value: unknown;
  onChange: (v: unknown) => void;
  allAnswers?: Record<string, unknown>;
  allQuestions?: Question[];
}> = ({ index, numberLabel, question, value, onChange, allAnswers, allQuestions }) => {
  const opts =
    question.type === 'section' ? [] : ensureOptionShape(question.options);
  const cls =
    'w-full text-sm border border-slate-200 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500';
  const answersMap = allAnswers ?? {};

  const getOptionDisabled = useCallback(
    (optValue: string) => {
      const o = opts.find((x) => x.value === optValue);
      return o ? isChoiceOptionDisabled(o, answersMap) : false;
    },
    [opts, answersMap]
  );

  useEffect(() => {
    if (question.type !== 'multiselect' && question.type !== 'checkbox') return;
    const optionList = ensureOptionShape(question.options);
    const arr = Array.isArray(value) ? (value as string[]) : [];
    const filtered = arr.filter((pv) => {
      const o = optionList.find((x) => x.value === pv);
      return !o || !isChoiceOptionDisabled(o, answersMap);
    });
    if (filtered.length !== arr.length) onChange(filtered);
  }, [question.type, question.id, question.options, value, answersMap, onChange]);

  if (question.type === 'section') {
    return (
      <div className="border-t-2 border-indigo-200 pt-3">
        <div className="text-[10px] font-bold text-indigo-600 uppercase tracking-wider">Section</div>
        <h4 className="text-base font-bold text-slate-900">{question.question}</h4>
        {question.description && (
          <p className="text-xs text-slate-500 mt-1">{question.description}</p>
        )}
      </div>
    );
  }

  let body: React.ReactNode = null;
  switch (question.type) {
    case 'text':
    case 'email':
    case 'phone':
      body = (
        <input
          type={
            question.type === 'email' ? 'email' : question.type === 'phone' ? 'tel' : 'text'
          }
          inputMode={question.type === 'phone' ? 'tel' : undefined}
          value={(value as string) || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            question.placeholder ||
            (question.type === 'email'
              ? 'name@example.com'
              : question.type === 'phone'
                ? '01712345678'
                : undefined)
          }
          className={cls}
        />
      );
      break;
    case 'longtext':
      body = (
                      <textarea
          value={(value as string) || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={question.placeholder}
                        rows={3}
          className={`${cls} resize-none`}
        />
      );
      break;
    case 'number':
      body = (
        <input
          type="number"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={question.placeholder}
          min={question.validation?.min}
          max={question.validation?.max}
          step={question.validation?.step}
          className={cls}
        />
      );
      break;
    case 'age': {
      const ageVal = (value && typeof value === 'object' ? value : {}) as {
        years?: number | string;
        months?: number | string;
      };
      const yrs = ageVal.years === undefined ? '' : String(ageVal.years);
      const mos = ageVal.months === undefined ? '' : String(ageVal.months);
      const commit = (ny: string, nm: string) => {
        const y = ny === '' ? undefined : Math.max(0, Number(ny));
        const mRaw = nm === '' ? undefined : Math.max(0, Number(nm));
        const m = mRaw === undefined ? undefined : Math.min(11, mRaw);
        if (y === undefined && m === undefined) {
          onChange(undefined);
          return;
        }
        const yy = y ?? 0;
        const mm = m ?? 0;
        onChange({ years: yy, months: mm, totalMonths: yy * 12 + mm });
      };
      body = (
        <div className="flex items-stretch gap-2">
          <div className="flex-1 min-w-0 relative">
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={150}
              step={1}
              value={yrs}
              onChange={(e) => commit(e.target.value, mos)}
              placeholder="0"
              className={`${cls} pr-12`}
            />
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              Years
            </span>
          </div>
          <div className="flex-1 min-w-0 relative">
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={11}
              step={1}
              value={mos}
              onChange={(e) => commit(yrs, e.target.value)}
              placeholder="0"
              className={`${cls} pr-14`}
            />
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              Months
            </span>
          </div>
        </div>
      );
      break;
    }
    case 'computed': {
      const res = evaluateComputed(
        question.computed,
        allAnswers ?? {},
        allQuestions ?? []
      );
      body = (
        <ComputedReadOnlyDisplay
          display={res.display}
          spec={question.computed}
        />
      );
      break;
    }
    case 'date':
      body = (
        <input type="date" value={(value as string) || ''} onChange={(e) => onChange(e.target.value)} className={cls} />
      );
      break;
    case 'time':
      body = (
        <input type="time" value={(value as string) || ''} onChange={(e) => onChange(e.target.value)} className={cls} />
      );
      break;
    case 'datetime':
      body = (
        <input
          type="datetime-local"
          value={(value as string) || ''}
          onChange={(e) => onChange(e.target.value)}
          className={cls}
        />
      );
      break;
    case 'select':
      body = (
        <ChoiceWithOtherFields
          mode="select"
          name={question.id}
          options={opts}
          allowOther={question.allowOther}
          value={value}
          onChange={onChange}
          className={cls}
          getOptionDisabled={getOptionDisabled}
        />
      );
      break;
    case 'multiselect':
      body = (
        <select
          multiple
          value={(value as string[]) || []}
          onChange={(e) => {
            const picked = Array.from(
              e.target.selectedOptions as HTMLCollectionOf<HTMLOptionElement>
            ).map((o) => o.value);
            const filtered = picked.filter((pv) => {
              const o = opts.find((x) => x.value === pv);
              return !o || !isChoiceOptionDisabled(o, answersMap);
            });
            onChange(filtered);
          }}
          className={`${cls} h-32`}
        >
          {opts.map((o) => (
            <option key={o.id} value={o.value} disabled={isChoiceOptionDisabled(o, answersMap)}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    case 'radio':
      body = (
        <ChoiceWithOtherFields
          mode="radio"
          name={question.id}
          options={opts}
          allowOther={question.allowOther}
          value={value}
          onChange={onChange}
          className={cls}
          getOptionDisabled={getOptionDisabled}
        />
      );
      break;
    case 'checkbox':
      body = (
        <div className="space-y-1.5">
          {opts.map((o) => {
            const arr = Array.isArray(value) ? (value as string[]) : [];
            return (
              <label
                key={o.id}
                className={`flex items-center gap-2 text-sm ${
                  isChoiceOptionDisabled(o, answersMap) ? 'text-slate-400' : 'text-slate-700'
                }`}
              >
                <input
                  type="checkbox"
                  disabled={isChoiceOptionDisabled(o, answersMap)}
                  checked={arr.includes(o.value)}
                  onChange={(e) => {
                    onChange(
                      e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value)
                    );
                  }}
                />
                {o.label}
              </label>
            );
          })}
        </div>
      );
      break;
    case 'rating': {
      const max = question.validation?.max ?? 5;
      const cur = Number(value || 0);
      body = (
        <div className="flex gap-1">
          {Array.from({ length: max }).map((_, i) => (
            <button
              key={i}
              onClick={() => onChange(i + 1)}
              className={i < cur ? 'text-amber-400' : 'text-slate-300'}
            >
              <Star size={22} fill={i < cur ? 'currentColor' : 'none'} />
            </button>
          ))}
        </div>
      );
      break;
    }
    case 'scale': {
      const min = question.validation?.min ?? 1;
      const max = question.validation?.max ?? 10;
      const cur = Number(value || min);
      body = (
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold text-slate-500">{min}</span>
          <input
            type="range"
            min={min}
            max={max}
            value={cur}
            onChange={(e) => onChange(Number(e.target.value))}
            className="flex-1"
          />
          <span className="text-xs font-semibold text-slate-500">{max}</span>
          <span className="text-sm font-bold text-blue-700 w-8 text-right">{cur}</span>
        </div>
      );
      break;
    }
    case 'location': {
      const gpsCfg: GpsCaptureSettings = {
        accuracyMeters: question.gpsSettings?.accuracyMeters ?? 10,
        stabilizationSeconds: question.gpsSettings?.stabilizationSeconds ?? 10,
        required: question.gpsSettings?.required ?? question.required ?? false,
        autoStart: question.gpsSettings?.autoStart ?? false,
        allowManualOverride: question.gpsSettings?.allowManualOverride ?? false
      };
      body = (
        <SubmissionGpsCaptureWidget
          config={gpsCfg}
          variant="card"
          onChange={(s) =>
            onChange(
              s
                ? {
                    lat: s.lat,
                    lng: s.lng,
                    accuracy: s.accuracy,
                    durationSeconds: s.durationSeconds
                  }
                : null
            )
          }
        />
      );
      break;
    }
    case 'photo':
      body = <PhotoCaptureWidget value={value} onChange={(next) => onChange(next)} />;
      break;
    case 'signature':
      body = (
        <div className={`${cls} bg-slate-50 text-slate-400 text-xs italic`}>
          Signature pad (rendered on device)
        </div>
      );
      break;
    case 'matrix':
      body = (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <th />
                {(question.columns || []).map((c) => (
                  <th key={c} className="text-xs font-semibold text-slate-600 px-2 py-1">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(question.rows || []).map((r) => {
                const matrixVal = (value as Record<string, string>) || {};
                return (
                  <tr key={r} className="border-t border-slate-100">
                    <td className="text-xs text-slate-700 pr-2">{r}</td>
                    {(question.columns || []).map((c) => (
                      <td key={`${r}_${c}`} className="text-center px-2 py-1">
                        <input
                          type="radio"
                          name={`${question.id}_${r}`}
                          checked={matrixVal[r] === c}
                          onChange={() => onChange({ ...matrixVal, [r]: c })}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
      break;
    default:
      body = null;
  }

  const prefix = numberLabel !== undefined ? numberLabel : String(index + 1);
  return (
    <div className="space-y-2">
      <label className="block text-sm font-semibold text-slate-800">
        {prefix !== '' && `${prefix}. `}
        {question.question || 'Untitled question'}
        {question.required && <span className="text-red-500 ml-1">*</span>}
      </label>
      {question.description && (
        <p className="text-xs text-slate-500 -mt-1">{question.description}</p>
      )}
      {body}
                </div>
  );
};

// ===========================================================================
// EnumeratorInfoEditor — configurable "enumerator info" table on the builder
// canvas (above the questions). Fields reuse the Question shape so admins
// configure them the same way they add a question.
// ===========================================================================

/**
 * Curated subset of question types appropriate for enumerator-info fields.
 * (Hides matrix / section / signature / photo which don't fit a 2-column
 * label/value table layout.)
 */
const ENUMERATOR_INFO_TYPES: QuestionType[] = [
  'text',
  'longtext',
  'number',
  'age',
  'email',
  'phone',
  'date',
  'time',
  'datetime',
  'select',
  'radio',
  'checkbox',
  'multiselect'
];

const EnumeratorInfoEditor: React.FC<{
  info: EnumeratorInfo;
  onChange: (info: EnumeratorInfo) => void;
}> = ({ info, onChange }) => {
  const [pickerOpen, setPickerOpen] = useState(false);
  // Anchor the dropdown via fixed positioning so it escapes the parent
  // card's `overflow-hidden` clipping and any scrollable ancestors.
  const addButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const [pickerPos, setPickerPos] = useState<{ top: number; left: number }>({
    top: 0,
    left: 0
  });

  const openPicker = () => {
    const rect = addButtonRef.current?.getBoundingClientRect();
    if (rect) setPickerPos({ top: rect.bottom + 4, left: rect.left });
    setPickerOpen(true);
  };

  const updateField = (id: string, patch: Partial<Question>) =>
    onChange({
      ...info,
      fields: info.fields.map((f) => (f.id === id ? { ...f, ...patch } : f))
    });

  const removeField = (id: string) =>
    onChange({ ...info, fields: info.fields.filter((f) => f.id !== id) });

  const moveField = (id: string, dir: -1 | 1) => {
    const idx = info.fields.findIndex((f) => f.id === id);
    if (idx < 0) return;
    const target = idx + dir;
    if (target < 0 || target >= info.fields.length) return;
    const next = [...info.fields];
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange({ ...info, fields: next });
  };

  const addField = (type: QuestionType) => {
    const q = newDefaultQuestion(type);
    q.question = 'New Field';
    onChange({ ...info, fields: [...info.fields, q] });
    setPickerOpen(false);
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-5 py-3 bg-gradient-to-r from-indigo-50 to-blue-50 border-b border-slate-200">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center shadow-sm shadow-indigo-200">
            <IdCard size={16} className="text-white" />
              </div>
          <div>
            <div className="text-xs font-bold text-indigo-700 uppercase tracking-wider">
              Enumerator Information
            </div>
            <p className="text-[11px] text-slate-500">
              Captured as a table at the top of the survey, before questions.
              Name, ID, phone and email are auto-filled from the enumerator account and not editable.
            </p>
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
            checked={info.enabled}
            onChange={(e) => onChange({ ...info, enabled: e.target.checked })}
                      />
          Enabled
                    </label>
                  </div>

      {info.enabled && (
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                Section Title
              </label>
              <input
                type="text"
                value={info.title}
                onChange={(e) => onChange({ ...info, title: e.target.value })}
                placeholder="Enumerator Information"
                className="w-full text-sm px-2.5 py-1.5 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                Helper text (optional)
              </label>
              <input
                type="text"
                value={info.description || ''}
                onChange={(e) => onChange({ ...info, description: e.target.value })}
                placeholder="Short instruction shown above the table"
                className="w-full text-sm px-2.5 py-1.5 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {info.fields.length === 0 ? (
            <div className="border-2 border-dashed border-slate-200 rounded-lg p-5 text-center text-xs text-slate-500">
              No enumerator-info fields yet. Add fields below.
            </div>
          ) : (
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                    <th className="px-3 py-2 text-left w-[40%]">Label</th>
                    <th className="px-3 py-2 text-left">Type</th>
                    <th className="px-3 py-2 text-left">Options</th>
                    <th className="px-3 py-2 text-center w-20">Required</th>
                    <th className="px-3 py-2 text-right w-24">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {info.fields.map((f, idx) => (
                    <EnumeratorInfoFieldRow
                      key={f.id}
                      field={f}
                      onUpdate={(patch) => updateField(f.id, patch)}
                      onRemove={() => removeField(f.id)}
                      onMoveUp={() => moveField(f.id, -1)}
                      onMoveDown={() => moveField(f.id, 1)}
                      canMoveUp={idx > 0}
                      canMoveDown={idx < info.fields.length - 1}
                    />
                  ))}
                </tbody>
              </table>
          </div>
          )}

          <div className="inline-block">
            <button
              ref={addButtonRef}
              onClick={() => (pickerOpen ? setPickerOpen(false) : openPicker())}
              className="text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 rounded-md flex items-center gap-1.5"
            >
              <Plus size={13} /> Add Field
              <ChevronDown size={12} />
            </button>
            {pickerOpen && (
              <>
                <div
                  className="fixed inset-0 z-[1011]"
                  onClick={() => setPickerOpen(false)}
                />
                <div
                  style={{ position: 'fixed', top: pickerPos.top, left: pickerPos.left }}
                  className="z-[1012] w-56 bg-white rounded-lg shadow-xl border border-slate-200 max-h-72 overflow-y-auto py-1"
                >
                  {ENUMERATOR_INFO_TYPES.map((t) => {
                    const def = QUESTION_TYPE_BY_KEY[t];
                    if (!def) return null;
                    return (
                      <button
                        key={t}
                        onClick={() => addField(t)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-indigo-50 transition-colors"
                      >
                        <def.Icon size={14} className="text-slate-500" />
                        <div>
                          <div className="text-xs font-semibold text-slate-800">{def.label}</div>
                          <div className="text-[10px] text-slate-400">{def.hint}</div>
        </div>
                      </button>
                    );
                  })}
      </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const EnumeratorInfoFieldRow: React.FC<{
  field: Question;
  onUpdate: (patch: Partial<Question>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}> = ({ field, onUpdate, onRemove, onMoveUp, onMoveDown, canMoveUp, canMoveDown }) => {
  const isChoice = isChoiceType(field.type);
  const opts = ensureOptionShape(field.options);

  return (
    <tr className="hover:bg-slate-50/60">
      <td className="px-3 py-2 align-top">
        <input
          type="text"
          value={field.question}
          onChange={(e) => onUpdate({ question: e.target.value })}
          placeholder="Field label"
          className="w-full text-sm font-medium px-2 py-1 border border-transparent hover:border-slate-200 focus:border-blue-500 rounded focus:outline-none"
        />
        <input
          type="text"
          value={field.key || ''}
          onChange={(e) => onUpdate({ key: e.target.value })}
          placeholder={slugify(field.question) || 'field_key'}
          className="w-full text-[10px] text-slate-400 px-2 py-0.5 border border-transparent hover:border-slate-200 focus:border-blue-500 rounded focus:outline-none font-mono"
        />
      </td>
      <td className="px-3 py-2 align-top">
        <select
          value={field.type}
          onChange={(e) => onUpdate({ type: e.target.value as QuestionType })}
          className="w-full text-xs px-2 py-1 border border-slate-200 rounded bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {ENUMERATOR_INFO_TYPES.map((t) => (
            <option key={t} value={t}>
              {QUESTION_TYPE_BY_KEY[t]?.label || t}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2 align-top">
        {isChoice ? (
          <div>
            <input
              type="text"
              value={opts.map((o) => o.label).join(', ')}
              onChange={(e) => {
                const labels = e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean);
                onUpdate({
                  options: labels.map((label) => ({
                    id: uid('o'),
                    value: slugify(label) || label,
                    label
                  }))
                });
              }}
              placeholder="Option A, Option B, Option C"
              className="w-full text-xs px-2 py-1 border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-[10px] text-slate-400 mt-0.5">
              Comma-separated options
            </p>
          </div>
        ) : (
          <span className="text-[10px] text-slate-400 italic">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-center align-middle">
        <input
          type="checkbox"
          checked={field.required}
          onChange={(e) => onUpdate({ required: e.target.checked })}
        />
      </td>
      <td className="px-3 py-2 align-middle">
        <div className="flex items-center justify-end gap-0.5">
          <button
            onClick={onMoveUp}
            disabled={!canMoveUp}
            className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
            title="Move up"
          >
            <ArrowUp size={13} />
          </button>
          <button
            onClick={onMoveDown}
            disabled={!canMoveDown}
            className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
            title="Move down"
          >
            <ArrowDown size={13} />
          </button>
          <button
            onClick={onRemove}
            className="p-1 text-red-400 hover:text-red-600"
            title="Delete"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </td>
    </tr>
  );
};

// ===========================================================================
// EnumeratorInfoTable — read-only/preview render: 2-column form table
// ===========================================================================

const EnumeratorInfoTable: React.FC<{
  info: EnumeratorInfo;
  answers: Record<string, unknown>;
  logicAnswers?: Record<string, unknown>;
  onChange: (fieldId: string, value: unknown) => void;
}> = ({ info, answers, logicAnswers, onChange }) => {
  const cls =
    'w-full text-sm border border-slate-200 rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500';
  const logicCtx = logicAnswers ?? answers;

  const renderInput = (f: Question) => {
    const v = answers[f.id];
    const opts = ensureOptionShape(f.options);
    const getOptionDisabled = (optValue: string) => {
      const o = opts.find((x) => x.value === optValue);
      return o ? isChoiceOptionDisabled(o, logicCtx) : false;
    };
    switch (f.type) {
      case 'text':
      case 'email':
      case 'phone':
        return (
          <input
            type="text"
            value={(v as string) || ''}
            onChange={(e) => onChange(f.id, e.target.value)}
            placeholder={f.placeholder}
            className={cls}
          />
        );
      case 'longtext':
        return (
                      <textarea
            value={(v as string) || ''}
            onChange={(e) => onChange(f.id, e.target.value)}
            placeholder={f.placeholder}
            rows={2}
            className={`${cls} resize-none`}
          />
        );
      case 'number':
        return (
          <input
            type="number"
            value={(v as string) ?? ''}
            onChange={(e) => onChange(f.id, e.target.value)}
            className={cls}
          />
        );
      case 'age': {
        const ageVal = (v && typeof v === 'object' ? v : {}) as {
          years?: number | string;
          months?: number | string;
        };
        const yrs = ageVal.years === undefined ? '' : String(ageVal.years);
        const mos = ageVal.months === undefined ? '' : String(ageVal.months);
        const commit = (ny: string, nm: string) => {
          const y = ny === '' ? undefined : Math.max(0, Number(ny));
          const mRaw = nm === '' ? undefined : Math.max(0, Number(nm));
          const m = mRaw === undefined ? undefined : Math.min(11, mRaw);
          if (y === undefined && m === undefined) {
            onChange(f.id, undefined);
            return;
          }
          const yy = y ?? 0;
          const mm = m ?? 0;
          onChange(f.id, { years: yy, months: mm, totalMonths: yy * 12 + mm });
        };
        return (
          <div className="flex gap-2">
            <div className="flex-1 min-w-0 relative">
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={150}
                step={1}
                value={yrs}
                onChange={(e) => commit(e.target.value, mos)}
                placeholder="0"
                className={`${cls} pr-12`}
              />
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                Years
              </span>
            </div>
            <div className="flex-1 min-w-0 relative">
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={11}
                step={1}
                value={mos}
                onChange={(e) => commit(yrs, e.target.value)}
                placeholder="0"
                className={`${cls} pr-14`}
              />
              <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                Months
              </span>
            </div>
          </div>
        );
      }
      case 'date':
        return (
          <input
            type="date"
            value={(v as string) || ''}
            onChange={(e) => onChange(f.id, e.target.value)}
            className={cls}
          />
        );
      case 'time':
        return (
          <input
            type="time"
            value={(v as string) || ''}
            onChange={(e) => onChange(f.id, e.target.value)}
            className={cls}
          />
        );
      case 'datetime':
        return (
          <input
            type="datetime-local"
            value={(v as string) || ''}
            onChange={(e) => onChange(f.id, e.target.value)}
            className={cls}
          />
        );
      case 'select':
        return (
          <ChoiceWithOtherFields
            mode="select"
            name={f.id}
            options={opts}
            allowOther={f.allowOther}
            value={v}
            onChange={(next) => onChange(f.id, next)}
            className={cls}
            getOptionDisabled={getOptionDisabled}
          />
        );
      case 'radio':
        return (
          <ChoiceWithOtherFields
            mode="radio"
            name={f.id}
            options={opts}
            allowOther={f.allowOther}
            value={v}
            onChange={(next) => onChange(f.id, next)}
            className={cls}
            getOptionDisabled={getOptionDisabled}
          />
        );
      case 'checkbox': {
        const arr = Array.isArray(v) ? (v as string[]) : [];
        return (
          <div className="flex flex-wrap gap-3">
            {opts.map((o) => (
              <label
                key={o.id}
                className={`flex items-center gap-1.5 text-xs ${
                  isChoiceOptionDisabled(o, logicCtx) ? 'text-slate-400' : 'text-slate-700'
                }`}
              >
                <input
                  type="checkbox"
                  disabled={isChoiceOptionDisabled(o, logicCtx)}
                  checked={arr.includes(o.value)}
                  onChange={(e) =>
                    onChange(
                      f.id,
                      e.target.checked ? [...arr, o.value] : arr.filter((x) => x !== o.value)
                    )
                  }
                />
                {o.label}
              </label>
            ))}
    </div>
  );
      }
      case 'multiselect':
        return (
          <select
            multiple
            value={(v as string[]) || []}
            onChange={(e) =>
              onChange(
                f.id,
                Array.from(
                  e.target.selectedOptions as HTMLCollectionOf<HTMLOptionElement>
                )
                  .map((o) => o.value)
                  .filter((pv) => {
                    const o = opts.find((x) => x.value === pv);
                    return !o || !isChoiceOptionDisabled(o, logicCtx);
                  })
              )
            }
            className={`${cls} h-24`}
          >
            {opts.map((o) => (
              <option key={o.id} value={o.value} disabled={isChoiceOptionDisabled(o, logicCtx)}>
                {o.label}
              </option>
            ))}
          </select>
        );
      default:
        return null;
    }
  };

  return (
    <div className="bg-gradient-to-r from-indigo-50/40 to-blue-50/40 rounded-lg border border-indigo-100 overflow-hidden">
      <div className="px-4 py-2.5 bg-indigo-600 text-white flex items-center gap-2">
        <IdCard size={16} />
        <div>
          <div className="text-sm font-bold">{info.title || 'Enumerator Information'}</div>
          {info.description && (
            <div className="text-[11px] text-indigo-100/90">{info.description}</div>
                  )}
                </div>
              </div>
      <table className="w-full text-sm border-collapse">
        <tbody>
          {info.fields.map((f) => (
            <tr key={f.id} className="border-t border-indigo-100/80 first:border-t-0">
              <th className="text-left text-xs font-semibold text-slate-700 align-middle bg-indigo-50/70 px-4 py-2 w-1/3 border-r border-indigo-100/80">
                {f.question || 'Untitled field'}
                {f.required && <span className="text-red-500 ml-1">*</span>}
              </th>
              <td className="px-4 py-2 align-middle bg-white">{renderInput(f)}</td>
            </tr>
          ))}
        </tbody>
      </table>
          </div>
  );
};

// ===========================================================================
// SubmissionGpsEditor — admin-side config card for end-of-survey GPS capture
// ===========================================================================

const SubmissionGpsEditor: React.FC<{
  gps: SubmissionGpsCapture;
  onChange: (gps: SubmissionGpsCapture) => void;
}> = ({ gps, onChange }) => {
  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-5 py-3 bg-gradient-to-r from-emerald-50 to-teal-50 border-b border-slate-200">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center shadow-sm shadow-emerald-200">
            <Satellite size={16} className="text-white" />
          </div>
          <div>
            <div className="text-xs font-bold text-emerald-700 uppercase tracking-wider">
              Submission GPS Location
            </div>
            <p className="text-[11px] text-slate-500">
              Auto-captured at the end of the survey. Stabilization window + accuracy gate.
            </p>
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={gps.enabled}
            onChange={(e) => onChange({ ...gps, enabled: e.target.checked })}
          />
          Enabled
        </label>
      </div>

      {gps.enabled && (
        <div className="p-5 space-y-3">
          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
              Section Title
            </label>
            <input
              type="text"
              value={gps.title}
              onChange={(e) => onChange({ ...gps, title: e.target.value })}
              placeholder="Submission GPS Location"
              className="w-full text-sm px-2.5 py-1.5 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
              Helper Description
            </label>
            <textarea
              value={gps.description}
              onChange={(e) => onChange({ ...gps, description: e.target.value })}
              rows={3}
              placeholder="Explain to the enumerator what's happening while GPS stabilizes."
              className="w-full text-sm px-2.5 py-1.5 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500 resize-y"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                Required Accuracy
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={gps.accuracyMeters}
                  onChange={(e) =>
                    onChange({
                      ...gps,
                      accuracyMeters: Math.max(1, Number(e.target.value) || 0)
                    })
                  }
                  className="w-full text-sm px-2.5 py-1.5 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
                <span className="text-xs font-semibold text-slate-500">m</span>
              </div>
              <p className="text-[10px] text-slate-400 mt-1">
                Capture only accepted once the reported accuracy ≤ this value.
              </p>
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                Stabilization Delay
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={gps.stabilizationSeconds}
                  onChange={(e) =>
                    onChange({
                      ...gps,
                      stabilizationSeconds: Math.max(1, Number(e.target.value) || 0)
                    })
                  }
                  className="w-full text-sm px-2.5 py-1.5 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
                <span className="text-xs font-semibold text-slate-500">s</span>
              </div>
              <p className="text-[10px] text-slate-400 mt-1">
                Minimum continuous watch time before a sample can lock.
              </p>
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                Required to Submit
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-700 mt-2">
                <input
                  type="checkbox"
                  checked={gps.required}
                  onChange={(e) => onChange({ ...gps, required: e.target.checked })}
                />
                Block submission until GPS is captured
              </label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ===========================================================================
// SubmissionGpsCaptureWidget — preview/runtime widget that watches the GPS
// with the configured stabilization window and accuracy gate.
// ===========================================================================

interface CapturedSample {
  lat: number;
  lng: number;
  accuracy: number;
  takenAt: number;
}

type GpsCaptureState =
  | { phase: 'idle' }
  | { phase: 'watching'; startedAt: number; best: CapturedSample | null; samples: number }
  | {
      phase: 'locked';
      best: CapturedSample;
      durationSeconds: number;
      samples: number;
    }
  | { phase: 'error'; message: string };

interface GpsCaptureWidgetProps {
  /** Capture settings (accuracy gate + stabilization window). */
  config: GpsCaptureSettings;
  /** Optional header title; omit to render a "bare" body suitable for inline use. */
  title?: string;
  /** Optional helper text shown above the capture controls. */
  description?: string;
  /** Visual variant: `card` (default) shows the gradient header, `inline` is minimal. */
  variant?: 'card' | 'inline';
  /** Notified whenever the captured sample changes (or is cleared). */
  onChange?: (
    sample: { lat: number; lng: number; accuracy: number; durationSeconds: number } | null
  ) => void;
}

const SubmissionGpsCaptureWidget: React.FC<GpsCaptureWidgetProps> = ({
  config,
  title,
  description,
  variant = 'card',
  onChange
}) => {
  const [state, setState] = useState<GpsCaptureState>({ phase: 'idle' });
  const [elapsedSec, setElapsedSec] = useState(0);
  const watchIdRef = React.useRef<number | null>(null);
  const stopWatchTimerRef = React.useRef<number | null>(null);

  const clearWatch = () => {
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    if (stopWatchTimerRef.current != null) {
      clearInterval(stopWatchTimerRef.current);
      stopWatchTimerRef.current = null;
    }
  };

  useEffect(() => () => clearWatch(), []);

  // Notify parent whenever the captured sample changes (lock ↔ reset).
  useEffect(() => {
    if (!onChange) return;
    if (state.phase === 'locked') {
      onChange({
        lat: state.best.lat,
        lng: state.best.lng,
        accuracy: state.best.accuracy,
        durationSeconds: state.durationSeconds
      });
    } else if (state.phase === 'idle') {
      onChange(null);
    }
  }, [state, onChange]);

  const overrideLock = () => {
    setState((cur) => {
      if (cur.phase !== 'watching' || !cur.best) return cur;
      clearWatch();
      const elapsedMs = Date.now() - cur.startedAt;
      return {
        phase: 'locked',
        best: cur.best,
        durationSeconds: elapsedMs / 1000,
        samples: cur.samples
      };
    });
  };

  const start = () => {
    if (!('geolocation' in navigator)) {
      setState({
        phase: 'error',
        message: 'Geolocation is not supported on this device.'
      });
      return;
    }
    clearWatch();
    const startedAt = Date.now();
    setElapsedSec(0);
    setState({ phase: 'watching', startedAt, best: null, samples: 0 });

    // Tick every 200ms — updates elapsed and locks in once gate conditions met.
    stopWatchTimerRef.current = window.setInterval(() => {
      setState((cur) => {
        if (cur.phase !== 'watching') return cur;
        const elapsedMs = Date.now() - cur.startedAt;
        setElapsedSec(Math.floor(elapsedMs / 100) / 10);
        if (
          cur.best &&
          cur.best.accuracy <= config.accuracyMeters &&
          elapsedMs >= config.stabilizationSeconds * 1000
        ) {
          // Lock!
          clearWatch();
          return {
            phase: 'locked',
            best: cur.best,
            durationSeconds: elapsedMs / 1000,
            samples: cur.samples
          };
        }
        return cur;
      });
    }, 200);

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        const sample: CapturedSample = {
          lat: latitude,
          lng: longitude,
          accuracy: typeof accuracy === 'number' ? accuracy : Number.POSITIVE_INFINITY,
          takenAt: Date.now()
        };
        setState((cur) => {
          if (cur.phase !== 'watching') return cur;
          const next = {
            ...cur,
            samples: cur.samples + 1,
            best: !cur.best || sample.accuracy < cur.best.accuracy ? sample : cur.best
          };
          return next;
        });
      },
      (err) => {
        clearWatch();
        setState({
          phase: 'error',
          message:
            err.code === err.PERMISSION_DENIED
              ? 'Location permission denied. Enable location services and retry.'
              : err.code === err.POSITION_UNAVAILABLE
                ? 'Location currently unavailable.'
                : err.code === err.TIMEOUT
                  ? 'GPS lookup timed out.'
                  : err.message
        });
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 }
    );
  };

  const reset = () => {
    clearWatch();
    setState({ phase: 'idle' });
    setElapsedSec(0);
  };

  // Optionally auto-start the watcher when the widget mounts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (config.autoStart) start();
    // We intentionally only run this on mount; subsequent autoStart toggles
    // should not auto-restart an already-locked capture.
  }, []);

  // ────────────────────────────────────────────────────────────────────────
  // UI
  // ────────────────────────────────────────────────────────────────────────
  const phase = state.phase;
  const headerTone =
    phase === 'locked'
      ? 'from-emerald-600 to-teal-600'
      : phase === 'error'
        ? 'from-red-600 to-rose-600'
        : 'from-emerald-500 to-teal-500';

  return (
    <div
      className={`rounded-lg overflow-hidden ${variant === 'card' ? 'border' : ''} ${
        phase === 'locked'
          ? 'border-emerald-200 bg-emerald-50/40'
          : phase === 'error'
            ? 'border-red-200 bg-red-50/40'
            : variant === 'card'
              ? 'border-emerald-200 bg-emerald-50/30'
              : ''
      }`}
    >
      {variant === 'card' && (
        <div
          className={`px-4 py-2.5 text-white flex items-center gap-2 bg-gradient-to-r ${headerTone}`}
        >
          <Satellite size={16} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold">{title || 'Submission GPS Location'}</div>
            <div className="text-[11px] text-white/90">
              Target accuracy ≤ {config.accuracyMeters} m • Stabilization{' '}
              {config.stabilizationSeconds} s
              {config.required && <> • Required</>}
            </div>
          </div>
        </div>
      )}

      <div className={variant === 'card' ? 'p-4 space-y-3' : 'space-y-3'}>
        {description && (
          <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
            {description}
          </p>
        )}

        {phase === 'idle' && (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <Crosshair size={14} className="text-emerald-600" />
              GPS is not yet acquired.
            </div>
            <button
              onClick={start}
              className="text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-md flex items-center gap-2"
            >
              <Locate size={15} /> Capture GPS Location
            </button>
          </div>
        )}

        {phase === 'watching' && (
          <WatchingPanel
            state={state as Extract<GpsCaptureState, { phase: 'watching' }>}
            elapsedSec={elapsedSec}
            config={config}
            onCancel={reset}
            onOverride={overrideLock}
          />
        )}

        {phase === 'locked' && (
          <LockedPanel
            state={state as Extract<GpsCaptureState, { phase: 'locked' }>}
            onRetake={reset}
          />
        )}

        {phase === 'error' && (
          <div className="flex items-start gap-2 text-sm">
            <AlertCircle size={16} className="text-red-600 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="text-red-700 font-semibold">
                {(state as Extract<GpsCaptureState, { phase: 'error' }>).message}
              </p>
              <button
                onClick={start}
                className="mt-2 text-xs font-semibold bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded-md"
              >
                Retry
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const WatchingPanel: React.FC<{
  state: Extract<GpsCaptureState, { phase: 'watching' }>;
  elapsedSec: number;
  config: GpsCaptureSettings;
  onCancel: () => void;
  onOverride?: () => void;
}> = ({ state, elapsedSec, config, onCancel, onOverride }) => {
  const stabilizeProgress = Math.min(100, (elapsedSec / config.stabilizationSeconds) * 100);
  const bestAccuracy = state.best?.accuracy;
  const accuracyOk = typeof bestAccuracy === 'number' && bestAccuracy <= config.accuracyMeters;
  const stabilized = elapsedSec >= config.stabilizationSeconds;
  const canOverride =
    config.allowManualOverride && stabilized && state.best && !accuracyOk;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <Loader2 size={16} className="text-emerald-600 animate-spin" />
        <span className="font-semibold text-emerald-700">
          Acquiring high-accuracy GPS…
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Stat
          label="Elapsed"
          value={`${elapsedSec.toFixed(1)} s`}
          hint={`min ${config.stabilizationSeconds} s`}
          ok={stabilized}
        />
        <Stat
          label="Best Accuracy"
          value={
            typeof bestAccuracy === 'number'
              ? `${bestAccuracy.toFixed(1)} m`
              : '—'
          }
          hint={`target ≤ ${config.accuracyMeters} m`}
          ok={accuracyOk}
        />
      </div>

      <div>
        <div className="flex justify-between text-[10px] font-semibold text-slate-500 mb-1">
          <span>Stabilization</span>
          <span>{Math.round(stabilizeProgress)}%</span>
        </div>
        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-emerald-500 transition-all"
            style={{ width: `${stabilizeProgress}%` }}
          />
        </div>
      </div>

      <p className="text-[11px] text-slate-500 italic">
        {state.samples} sample{state.samples === 1 ? '' : 's'} received. Stand still
        and keep the device under open sky for best results.
      </p>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={onCancel}
          className="text-xs font-semibold text-slate-600 hover:text-slate-800 underline"
        >
          Cancel and reset
        </button>
        {canOverride && onOverride && (
          <button
            onClick={onOverride}
            className="text-xs font-semibold text-amber-700 hover:text-amber-900 underline"
            title="Save the best sample so far even though accuracy is above the threshold"
          >
            Use anyway (±{bestAccuracy?.toFixed(1)} m)
          </button>
        )}
      </div>
    </div>
  );
};

const LockedPanel: React.FC<{
  state: Extract<GpsCaptureState, { phase: 'locked' }>;
  onRetake: () => void;
}> = ({ state, onRetake }) => {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <CheckCircle2 size={16} className="text-emerald-600" />
        <span className="font-semibold text-emerald-700">
          Location captured successfully.
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Latitude" value={state.best.lat.toFixed(6)} />
        <Stat label="Longitude" value={state.best.lng.toFixed(6)} />
        <Stat label="Accuracy" value={`${state.best.accuracy.toFixed(1)} m`} ok />
        <Stat
          label="Duration"
          value={`${state.durationSeconds.toFixed(1)} s`}
          hint={`${state.samples} sample${state.samples === 1 ? '' : 's'}`}
        />
      </div>
      <button
        onClick={onRetake}
        className="text-xs font-semibold text-emerald-700 hover:text-emerald-900 underline"
      >
        Re-capture
      </button>
    </div>
  );
};

const Stat: React.FC<{
  label: string;
  value: string;
  hint?: string;
  ok?: boolean;
}> = ({ label, value, hint, ok }) => (
  <div
    className={`border rounded-md px-2.5 py-1.5 ${
      ok ? 'border-emerald-200 bg-emerald-50/40' : 'border-slate-200 bg-white'
    }`}
  >
    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
      {label}
    </div>
    <div className="text-sm font-bold text-slate-800 break-all">{value}</div>
    {hint && <div className="text-[10px] text-slate-400">{hint}</div>}
  </div>
);

// ===========================================================================
// ConsentGateEditor — builder-side card for the permission-grant section
// ===========================================================================

const ConsentGateEditor: React.FC<{
  gate: ConsentGate;
  onChange: (gate: ConsentGate) => void;
}> = ({ gate, onChange }) => {
  const { user, userProfile } = useAuth();
  const previewName =
    enumeratorResolvedDisplayName(userProfile, user) || '(sign in to preview your name here)';
  const sub = gate.substituteEnumeratorName !== false;
  const previewText = formatConsentGateTemplate(gate.text, previewName, sub);
  const previewCheckbox = formatConsentGateTemplate(gate.checkboxLabel, previewName, sub);

  const insertNameToken = () => {
    const token = '{{enumeratorName}}';
    const t = gate.text;
    const spacer = t && !/\s$/.test(t) ? ' ' : '';
    onChange({ ...gate, text: t ? `${t}${spacer}${token}` : token });
  };

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-5 py-3 bg-gradient-to-r from-amber-50 to-orange-50 border-b border-slate-200">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-amber-600 flex items-center justify-center shadow-sm shadow-amber-200">
            <ShieldCheck size={16} className="text-white" />
        </div>
          <div>
            <div className="text-xs font-bold text-amber-700 uppercase tracking-wider">
              Permission Grant
            </div>
            <p className="text-[11px] text-slate-500">
              Questions are hidden until the enumerator confirms verbal consent.
            </p>
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={gate.enabled}
            onChange={(e) => onChange({ ...gate, enabled: e.target.checked })}
          />
          Enabled
        </label>
      </div>

      {gate.enabled && (
        <div className="p-5 space-y-3">
          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
              Section Title
            </label>
            <input
              type="text"
              value={gate.title}
              onChange={(e) => onChange({ ...gate, title: e.target.value })}
              placeholder="Permission Grant"
              className="w-full text-sm px-2.5 py-1.5 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
              Permission / Consent Paragraph
            </label>
            <textarea
              value={gate.text}
              onChange={(e) => onChange({ ...gate, text: e.target.value })}
              placeholder="Explain the purpose, voluntary nature, confidentiality, etc."
              rows={5}
              className="w-full text-sm px-2.5 py-1.5 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500 resize-y"
            />
            <div className="flex flex-wrap items-center gap-2 mt-1.5">
              <button
                type="button"
                onClick={insertNameToken}
                className="text-[10px] font-semibold text-amber-800 bg-amber-100 hover:bg-amber-200 border border-amber-200 rounded px-2 py-1"
              >
                Insert {'{{enumeratorName}}'}
              </button>
              <label className="flex items-center gap-1.5 text-[10px] text-slate-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={sub}
                  onChange={(e) => onChange({ ...gate, substituteEnumeratorName: e.target.checked })}
                />
                {"Replace placeholder with the signed-in enumerator's name when shown"}
              </label>
            </div>
            <p className="text-[10px] text-slate-400 mt-1">
              Shown to the enumerator as a paragraph above the consent checkbox. Use{' '}
              <code className="text-[10px] bg-slate-100 px-0.5 rounded">{'{{enumeratorName}}'}</code>{' '}
              (or <code className="text-[10px] bg-slate-100 px-0.5 rounded">{'{{enumerator_name}}'}</code>) where
              their name should appear, for example:{' '}
              <span className="italic">I, {'{{enumeratorName}}'}, confirm…</span>
            </p>
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
              Checkbox Label
            </label>
            <input
              type="text"
              value={gate.checkboxLabel}
              onChange={(e) => onChange({ ...gate, checkboxLabel: e.target.value })}
              placeholder="I confirm that I have obtained verbal consent…"
              className="w-full text-sm px-2.5 py-1.5 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
          </div>

          {/* Preview strip showing exactly how the gate will look to the enumerator */}
          <div className="mt-2 border border-amber-200 bg-amber-50/60 rounded-lg overflow-hidden">
            <div className="px-4 py-2 bg-amber-600 text-white flex items-center gap-2">
              <ShieldCheck size={14} />
              <span className="text-xs font-bold">{gate.title || 'Permission Grant'}</span>
            </div>
            <div className="p-4 space-y-3">
              <p className="text-xs text-slate-700 leading-relaxed whitespace-pre-wrap">
                {previewText || '(empty consent text)'}
              </p>
              <label className="flex items-start gap-2 text-xs text-slate-800 cursor-pointer">
                <input type="checkbox" disabled className="mt-0.5" />
                <span className="font-semibold">
                  {previewCheckbox || '(empty checkbox label)'}
                  <span className="text-red-500 ml-1">*</span>
                </span>
              </label>
              <p className="text-[10px] text-amber-700 italic">
                Live preview — questions on the enumerator side stay hidden until this is ticked.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ===========================================================================
// DescriptionEditor — block-based rich description editor for the builder
// ===========================================================================

const DescriptionEditor: React.FC<{
  blocks: DescriptionBlock[];
  onChange: (blocks: DescriptionBlock[]) => void;
}> = ({ blocks, onChange }) => {
  const update = (id: string, patch: Partial<DescriptionBlock>) => {
    onChange(
      blocks.map((b) => (b.id === id ? ({ ...b, ...patch } as DescriptionBlock) : b))
    );
  };
  const remove = (id: string) => onChange(blocks.filter((b) => b.id !== id));
  const move = (id: string, dir: -1 | 1) => {
    const idx = blocks.findIndex((b) => b.id === id);
    if (idx < 0) return;
    const target = idx + dir;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    [next[idx], next[target]] = [next[target], next[idx]];
    onChange(next);
  };
  const addHeading = () =>
    onChange([
      ...blocks,
      { id: uid('b'), type: 'heading', level: 2, text: 'Section Title' }
    ]);
  const addParagraph = () =>
    onChange([
      ...blocks,
      { id: uid('b'), type: 'paragraph', text: '' }
    ]);
  const addTable = () =>
    onChange([
      ...blocks,
      {
        id: uid('b'),
        type: 'table',
        rows: [
          ['Header 1', 'Header 2', 'Header 3'],
          ['', '', ''],
          ['', '', '']
        ]
      }
    ]);

  return (
    <div className="space-y-2">
      {blocks.length === 0 ? (
        <div className="border-2 border-dashed border-slate-200 rounded-lg p-5 text-center text-xs text-slate-500">
          Build a rich description by adding titles, paragraphs, or a table.
        </div>
      ) : (
        blocks.map((b, idx) => (
          <DescriptionBlockEditor
            key={b.id}
            block={b}
            onUpdate={(patch) => update(b.id, patch)}
            onRemove={() => remove(b.id)}
            onMoveUp={() => move(b.id, -1)}
            onMoveDown={() => move(b.id, 1)}
            canMoveUp={idx > 0}
            canMoveDown={idx < blocks.length - 1}
          />
        ))
      )}

      <div className="flex flex-wrap gap-2 pt-1">
          <button
          onClick={addHeading}
          className="text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 px-2.5 py-1.5 rounded-md flex items-center gap-1"
          >
          <HeadingIcon size={13} /> Add Title
          </button>
          <button
          onClick={addParagraph}
          className="text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 px-2.5 py-1.5 rounded-md flex items-center gap-1"
        >
          <Pilcrow size={13} /> Add Paragraph
        </button>
        <button
          onClick={addTable}
          className="text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 px-2.5 py-1.5 rounded-md flex items-center gap-1"
        >
          <TableIcon size={13} /> Add Table
          </button>
        </div>
      </div>
  );
};

const DescriptionBlockEditor: React.FC<{
  block: DescriptionBlock;
  onUpdate: (patch: Partial<DescriptionBlock>) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}> = ({ block, onUpdate, onRemove, onMoveUp, onMoveDown, canMoveUp, canMoveDown }) => {
  const Toolbar = (
    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
      <button
        onClick={onMoveUp}
        disabled={!canMoveUp}
        className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
        title="Move up"
      >
        <ArrowUp size={13} />
      </button>
      <button
        onClick={onMoveDown}
        disabled={!canMoveDown}
        className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
        title="Move down"
      >
        <ArrowDown size={13} />
      </button>
      <button
        onClick={onRemove}
        className="p-1 text-red-400 hover:text-red-600"
        title="Remove block"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );

  if (block.type === 'heading') {
    const sizeClass =
      block.level === 1
        ? 'text-2xl font-bold'
        : block.level === 2
          ? 'text-xl font-bold'
          : 'text-base font-bold';
    return (
      <div className="group border border-slate-200 rounded-lg bg-slate-50/40 p-2 hover:border-slate-300 transition-colors">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
            <HeadingIcon size={11} />
            Title
            <select
              value={block.level}
              onChange={(e) =>
                onUpdate({ level: Number(e.target.value) as 1 | 2 | 3 })
              }
              className="ml-1 text-[10px] font-bold bg-white border border-slate-200 rounded px-1.5 py-0.5"
            >
              <option value={1}>H1</option>
              <option value={2}>H2</option>
              <option value={3}>H3</option>
            </select>
          </div>
          {Toolbar}
        </div>
        <input
          type="text"
          value={block.text}
          onChange={(e) => onUpdate({ text: e.target.value })}
          placeholder="Title text…"
          className={`w-full bg-transparent border-0 focus:outline-none px-1 ${sizeClass} text-slate-900 placeholder-slate-300`}
        />
      </div>
    );
  }

  if (block.type === 'paragraph') {
    return (
      <div className="group border border-slate-200 rounded-lg bg-slate-50/40 p-2 hover:border-slate-300 transition-colors">
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
            <Pilcrow size={11} />
            Paragraph
          </div>
          {Toolbar}
        </div>
        <textarea
          value={block.text}
          onChange={(e) => onUpdate({ text: e.target.value })}
          placeholder="Write a paragraph…"
          rows={3}
          className="w-full bg-transparent border-0 focus:outline-none px-1 text-sm text-slate-700 placeholder-slate-300 resize-y"
        />
      </div>
    );
  }

  // Table
  const rows = block.rows;
  const cols = rows[0]?.length || 0;
  const setCell = (r: number, c: number, value: string) => {
    onUpdate({
      rows: rows.map((row, ri) =>
        ri === r ? row.map((cell, ci) => (ci === c ? value : cell)) : row
      )
    });
  };
  const addRow = () =>
    onUpdate({ rows: [...rows, Array.from({ length: cols }, () => '')] });
  const removeRow = (r: number) => {
    if (rows.length <= 1) return;
    onUpdate({ rows: rows.filter((_, ri) => ri !== r) });
  };
  const addCol = () =>
    onUpdate({ rows: rows.map((row) => [...row, '']) });
  const removeCol = (c: number) => {
    if (cols <= 1) return;
    onUpdate({ rows: rows.map((row) => row.filter((_, ci) => ci !== c)) });
  };

  return (
    <div className="group border border-slate-200 rounded-lg bg-slate-50/40 p-2 hover:border-slate-300 transition-colors">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
          <TableIcon size={11} />
          Table ({rows.length}×{cols})
        </div>
        {Toolbar}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className="group/row">
                {row.map((cell, ci) => (
                  <td key={ci} className="border border-slate-200 p-0 align-top">
                    <input
                      type="text"
                      value={cell}
                      onChange={(e) => setCell(ri, ci, e.target.value)}
                      placeholder={ri === 0 ? `Header ${ci + 1}` : ''}
                      className={`w-full px-2 py-1.5 bg-white focus:outline-none focus:bg-blue-50/40 ${
                        ri === 0 ? 'font-semibold text-slate-800' : 'text-slate-700'
                      }`}
                    />
                  </td>
                ))}
                <td className="w-7 align-middle text-center">
                  <button
                    onClick={() => removeRow(ri)}
                    disabled={rows.length <= 1}
                    className="p-1 text-red-300 hover:text-red-600 opacity-0 group-hover/row:opacity-100 disabled:opacity-0"
                    title="Remove row"
                  >
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
            <tr>
              {Array.from({ length: cols }).map((_, ci) => (
                <td key={ci} className="text-center p-0.5">
                  <button
                    onClick={() => removeCol(ci)}
                    disabled={cols <= 1}
                    className="p-1 text-red-300 hover:text-red-600 disabled:opacity-30"
                    title="Remove column"
                  >
                    <Trash2 size={11} />
                  </button>
                </td>
              ))}
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <div className="flex gap-2 mt-2">
        <button
          onClick={addRow}
          className="text-[11px] font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 px-2 py-1 rounded flex items-center gap-1"
        >
          <RowsIcon size={11} /> Add row
        </button>
        <button
          onClick={addCol}
          className="text-[11px] font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 px-2 py-1 rounded flex items-center gap-1"
        >
          <ColumnsIcon size={11} /> Add column
        </button>
      </div>
    </div>
  );
};

// ===========================================================================
// DescriptionRenderer — read-only display of rich description blocks
// ===========================================================================

const DescriptionRenderer: React.FC<{ blocks: DescriptionBlock[] }> = ({ blocks }) => {
  if (!blocks || blocks.length === 0) return null;
  return (
    <div className="space-y-3">
      {blocks.map((b) => {
        if (b.type === 'heading') {
          const sizeClass =
            b.level === 1
              ? 'text-2xl font-bold text-slate-900'
              : b.level === 2
                ? 'text-xl font-bold text-slate-900'
                : 'text-base font-bold text-slate-800';
          return (
            <div key={b.id} className={sizeClass}>
              {b.text || <span className="text-slate-300 italic">(empty title)</span>}
            </div>
          );
        }
        if (b.type === 'paragraph') {
          return (
            <p key={b.id} className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
              {b.text}
            </p>
          );
        }
        // table
        const [header, ...body] = b.rows;
        return (
          <div key={b.id} className="overflow-x-auto">
            <table className="w-full text-sm border-collapse border border-slate-200 rounded">
              {header && (
                <thead className="bg-slate-50">
                  <tr>
                    {header.map((cell, ci) => (
                      <th
                        key={ci}
                        className="border border-slate-200 px-3 py-2 text-left text-xs font-semibold text-slate-700"
                      >
                        {cell}
                      </th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody>
                {body.map((row, ri) => (
                  <tr key={ri} className="odd:bg-white even:bg-slate-50/40">
                    {row.map((cell, ci) => (
                      <td
                        key={ci}
                        className="border border-slate-200 px-3 py-2 text-slate-700"
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
};
