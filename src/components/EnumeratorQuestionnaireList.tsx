/**
 * EnumeratorQuestionnaireList — landing screen for enumerators who have
 * questionnaire tasks assigned. Shows the questionnaires they can fill,
 * grouped by project, with a submission counter. Used when the enumerator
 * has *only* questionnaire tasks (geospatial is skipped entirely) or as the
 * "Questionnaire Survey" tile when they have tasks in both segments.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  ClipboardList,
  FileText,
  LogOut,
  RefreshCw,
  Search,
  CheckCircle2,
  ChevronRight,
  AlertCircle,
  Loader2,
  ArrowLeft,
  Save,
  ShieldCheck,
  Eye,
  Edit3,
  Trash2,
  Plus
} from 'lucide-react';
import { collection, deleteDoc, doc, getDoc, query, where } from 'firebase/firestore';
import { commitFirestoreWrite, getDocsOfflineFriendly } from '../lib/offlineFirestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { Project, Questionnaire, QuestionnaireResponse, UserProfile } from '../types';
import { useAuth } from './AuthProvider';
import { QuestionnaireForm } from './QuestionnaireForm';
import { AppFooter } from './AppFooter';
import { DEFAULT_PROJECT_ID } from '../lib/projects';
import { fmtDate, tsToDate } from '../lib/responseExport';
import { ResponseIdCell } from './ResponseIdCell';

interface EnumeratorQuestionnaireListProps {
  userProfile: UserProfile;
  /** Optional back-link when the enumerator is in dual-segment mode. */
  onBack?: () => void;
  /** Logout handler — only shown when there is no back-link. */
  onLogout?: () => Promise<void> | void;
  /** Captured location to pre-fill on questionnaire submission, if any. */
  initialLocation?: { lat: number; lng: number; ward?: string };
}

/**
 * Per-questionnaire response stats *for the signed-in enumerator only*.
 * The latest draft (if any) is surfaced so the enumerator can resume it
 * with a single click — admins reviewing this user's drafts is out of
 * scope here (they have the admin Responses view for that).
 */
interface QuestionnaireStats {
  draft: number;
  submitted: number;
  reviewed: number;
  /** Most recent draft response for this questionnaire, if any. */
  latestDraft: QuestionnaireResponse | null;
  /** All this user's responses for this questionnaire, newest first. */
  all: QuestionnaireResponse[];
}

const EMPTY_STATS: QuestionnaireStats = {
  draft: 0,
  submitted: 0,
  reviewed: 0,
  latestDraft: null,
  all: []
};

/** Best-effort timestamp for ordering — `updatedAt` wins, then `submittedAt`. */
const responseTime = (r: QuestionnaireResponse): number =>
  tsToDate(r.updatedAt)?.getTime() ?? tsToDate(r.submittedAt)?.getTime() ?? 0;

export const EnumeratorQuestionnaireList: React.FC<EnumeratorQuestionnaireListProps> = ({
  userProfile,
  onBack,
  onLogout,
  initialLocation
}) => {
  const { user } = useAuth();
  const [questionnaires, setQuestionnaires] = useState<Questionnaire[]>([]);
  const [projects, setProjects] = useState<Record<string, Project>>({});
  const [responseStats, setResponseStats] = useState<Record<string, QuestionnaireStats>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [opening, setOpening] = useState<{
    questionnaire: Questionnaire;
    existingResponse?: QuestionnaireResponse;
    readOnly?: boolean;
    forceNew?: boolean;
  } | null>(null);
  /** Currently-open "My Responses" panel for one questionnaire. */
  const [responsesPanel, setResponsesPanel] = useState<Questionnaire | null>(null);
  /** Bumps to reload questionnaire docs + response stats (Refresh, form close/submit, draft delete). */
  const [refreshTick, setRefreshTick] = useState(0);

  const assignedIds = useMemo(() => {
    const list = userProfile.assignedQuestionnaireIds || [];
    return [...new Set(list.filter(Boolean))];
  }, [userProfile.assignedQuestionnaireIds]);

  // Fetch ONLY the questionnaires this enumerator is assigned to. We avoid
  // streaming the full /questionnaires collection (which would scale with the
  // whole org, not the user's task list) by issuing one `getDoc` per assigned
  // id in parallel. Re-runs whenever `assignedIds` change (which itself is
  // driven by the live user profile in AuthProvider, so admin edits flow
  // through without manual refresh) or when `refreshTick` increments (header
  // Refresh button, form close/submit).
  useEffect(() => {
    let cancelled = false;
    if (assignedIds.length === 0) {
      setQuestionnaires([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        const docs = await Promise.all(
          assignedIds.map((id) => getDoc(doc(db, 'questionnaires', id)))
        );
        if (cancelled) return;
        const list: Questionnaire[] = [];
        for (const snap of docs) {
          if (!snap.exists()) continue;
          list.push({ ...(snap.data() as Questionnaire), id: snap.id });
        }
        list.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
        setQuestionnaires(list);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to load questionnaires:', err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assignedIds, refreshTick]);

  // Project lookup so we can render the project name on each card. We only
  // need to read the project ids referenced by our questionnaires — full
  // /projects subscription is not necessary here. Fetched once per change of
  // the relevant id set; rarely changes.
  useEffect(() => {
    const idSet = new Set<string>();
    for (const q of questionnaires) {
      idSet.add(q.projectId || DEFAULT_PROJECT_ID);
    }
    const ids = Array.from(idSet);
    if (ids.length === 0) {
      setProjects({});
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const docs = await Promise.all(
          ids.map((id: string) => getDoc(doc(db, 'projects', id)))
        );
        if (cancelled) return;
        const next: Record<string, Project> = {};
        for (const snap of docs) {
          if (!snap.exists()) continue;
          next[snap.id] = { ...(snap.data() as Project), id: snap.id };
        }
        setProjects(next);
      } catch (err) {
        if (cancelled) return;
        console.warn('Failed to load projects:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [questionnaires]);

  // Response stats per questionnaire for THIS enumerator only. Drives the
  // status pills on each card, the "Resume draft" entry point, and the
  // "My Responses" panel. We keep the full per-questionnaire response list
  // (sorted newest first) so the panel never has to issue a second query.
  // Re-fetched whenever the form closes so counters/lists stay in sync
  // after the enumerator saves, submits, or deletes a draft.
  useEffect(() => {
    if (!user?.uid) return;
    let cancelled = false;
    const run = async () => {
      try {
        const q = query(
          collection(db, 'questionnaireResponses'),
          where('respondentId', '==', user.uid)
        );
        const snap = await getDocsOfflineFriendly(q);

        // Bucket by questionnaireId.
        const buckets: Record<string, QuestionnaireResponse[]> = {};
        snap.forEach((d) => {
          const data = d.data() as QuestionnaireResponse;
          const qid = data.questionnaireId;
          if (!qid) return;
          (buckets[qid] = buckets[qid] || []).push({ ...data, id: d.id });
        });

        const next: Record<string, QuestionnaireStats> = {};
        for (const [qid, list] of Object.entries(buckets)) {
          // Newest-touched first so "latest draft" is just `[0]` of drafts
          // and the panel renders in natural recency order.
          list.sort((a, b) => responseTime(b) - responseTime(a));
          let draft = 0;
          let submitted = 0;
          let reviewed = 0;
          let latestDraft: QuestionnaireResponse | null = null;
          for (const r of list) {
            if (r.status === 'draft') {
              draft += 1;
              if (!latestDraft) latestDraft = r;
            } else if (r.status === 'reviewed') reviewed += 1;
            else submitted += 1;
          }
          next[qid] = { draft, submitted, reviewed, latestDraft, all: list };
        }
        if (!cancelled) setResponseStats(next);
      } catch (e) {
        console.warn('Failed to fetch response stats:', e);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [user?.uid, questionnaires.length, refreshTick]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return questionnaires;
    return questionnaires.filter((it) => {
      const project = projects[it.projectId || DEFAULT_PROJECT_ID];
      const hay = `${it.title} ${it.description || ''} ${project?.name || ''} ${
        project?.code || ''
      }`.toLowerCase();
      return hay.includes(q);
    });
  }, [questionnaires, projects, search]);

  // Group by project so an enumerator with assignments across multiple
  // projects sees a clean section heading per project.
  const grouped = useMemo(() => {
    const map = new Map<string, { project?: Project; items: Questionnaire[] }>();
    for (const q of filtered) {
      const pid = q.projectId || DEFAULT_PROJECT_ID;
      const entry = map.get(pid) || { project: projects[pid], items: [] };
      entry.items.push(q);
      map.set(pid, entry);
    }
    return [...map.entries()].sort(([, a], [, b]) =>
      (a.project?.name || '').localeCompare(b.project?.name || '')
    );
  }, [filtered, projects]);

  const totalActive = questionnaires.filter((q) => q.isActive !== false).length;
  const totals = useMemo(() => {
    let draft = 0;
    let submitted = 0;
    let reviewed = 0;
    for (const s of Object.values(responseStats)) {
      draft += s.draft;
      submitted += s.submitted;
      reviewed += s.reviewed;
    }
    return { draft, submitted, reviewed };
  }, [responseStats]);

  /**
   * Clicking a questionnaire card opens the "My Responses" panel so the
   * enumerator can see *all* their prior responses (drafts + submitted +
   * reviewed) and choose: start new, continue a draft, view a submitted
   * one, or delete a draft. If there are zero responses for this
   * questionnaire the panel still opens — its empty state has the
   * "Start your first response" CTA front-and-center, so it's the same
   * single tap to begin surveying as before.
   */
  const openQuestionnaire = (q: Questionnaire) => {
    setResponsesPanel(q);
  };

  const handleDeleteDraft = async (r: QuestionnaireResponse) => {
    if (r.status !== 'draft') {
      alert('Only draft responses can be deleted. Contact an admin if you need help.');
      return;
    }
    if (!confirm('Delete this draft? This cannot be undone.')) return;
    try {
      await commitFirestoreWrite(() =>
        deleteDoc(doc(db, 'questionnaireResponses', r.id))
      );
      if (user?.uid && r.questionnaireId) {
        try {
          const key = `qc-draft:${user.uid}:${r.questionnaireId}`;
          if (sessionStorage.getItem(key) === r.id) {
            sessionStorage.removeItem(key);
          }
        } catch {
          /* ignore */
        }
      }
      setRefreshTick((t) => t + 1);
    } catch (err) {
      console.error('Delete draft failed:', err);
      try {
        handleFirestoreError(err, OperationType.DELETE, 'questionnaireResponses');
      } catch (logged) {
        const msg = logged instanceof Error ? logged.message : String(logged);
        alert(
          msg.includes('permission') || msg.includes('Permission')
            ? 'Could not delete this draft. If you are offline, try again when connected — or ask an admin to remove it.'
            : `Could not delete draft: ${msg}`
        );
      }
    }
  };

  return (
    <div className="qc-panel-scroll flex flex-col min-h-[100dvh] bg-gradient-to-br from-emerald-50/40 to-teal-50/30">
      <header className="bg-white/85 backdrop-blur border-b border-slate-200 shadow-sm pt-safe-top">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg"
              title="Back"
            >
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-md shadow-emerald-200 shrink-0">
            <ClipboardList size={20} className="text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-bold text-slate-900 leading-tight truncate">
              My Questionnaires
            </h1>
            <p className="text-[11px] text-slate-500 truncate">
              {userProfile.displayName || userProfile.email} · Enumerator
            </p>
          </div>
          <div className="hidden sm:flex items-center gap-3 text-xs text-slate-600">
            <span>
              <span className="font-bold text-slate-900">{totalActive}</span> assigned
            </span>
            {totals.draft > 0 && (
              <>
                <span>·</span>
                <span>
                  <span className="font-bold text-amber-700">{totals.draft}</span> draft
                  {totals.draft === 1 ? '' : 's'}
                </span>
              </>
            )}
            <span>·</span>
            <span>
              <span className="font-bold text-emerald-700">{totals.submitted}</span> submitted
            </span>
            {totals.reviewed > 0 && (
              <>
                <span>·</span>
                <span>
                  <span className="font-bold text-indigo-700">{totals.reviewed}</span> reviewed
                </span>
              </>
            )}
          </div>
          {!onBack && onLogout && (
            <button
              onClick={() => void onLogout()}
              className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg"
              title="Logout"
            >
              <LogOut size={18} />
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-5 sm:py-7">
        <div className="flex items-center gap-3 flex-wrap mb-4">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search questionnaires by title, description, or project…"
              className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100"
            />
          </div>
          <button
            onClick={() => setRefreshTick((t) => t + 1)}
            className="text-xs font-semibold px-3 py-2 rounded-lg text-slate-600 hover:bg-slate-100 inline-flex items-center gap-1.5"
            title="Refresh"
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 mb-4 flex items-start gap-2 text-sm">
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <p className="flex-1">{error}</p>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center text-slate-500 py-16">
            <Loader2 size={20} className="animate-spin mr-2" /> Loading your questionnaires…
          </div>
        ) : assignedIds.length === 0 ? (
          <EmptyState
            icon={<ClipboardList size={28} className="text-slate-300" />}
            title="No questionnaires assigned yet"
            message="Your admin hasn't assigned any questionnaires to you. They'll appear here as soon as they do."
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Search size={28} className="text-slate-300" />}
            title="No questionnaires match your search"
            message="Try a different search term, or clear the search to see everything."
          />
        ) : (
          <div className="space-y-6">
            {grouped.map(([pid, group]) => (
              <section key={pid}>
                {/* Project name/code are hidden on the enumerator view by
                    request — enumerators only see "their questionnaires"
                    and don't need project metadata. Grouping is kept so
                    cards from different projects stay visually separate. */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {group.items.map((q) => (
                    <QuestionnaireCard
                      key={q.id}
                      questionnaire={q}
                      stats={responseStats[q.id] || EMPTY_STATS}
                      onOpen={() => openQuestionnaire(q)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>
      <AppFooter className="border-t border-slate-200 bg-white/70 backdrop-blur" />

      {/* My Responses panel — a per-questionnaire response list scoped to
          the signed-in enumerator. Sits at z-[1002], below the form so
          the form can stack on top of it. When the form closes the panel
          is still mounted underneath, which is what the enumerator wants:
          after viewing / continuing / submitting they land back on their
          response list, not on the main questionnaire grid. */}
      {responsesPanel && (
        <MyResponsesPanel
          questionnaire={responsesPanel}
          stats={responseStats[responsesPanel.id] || EMPTY_STATS}
          onClose={() => setResponsesPanel(null)}
          onStartNew={() =>
            setOpening({ questionnaire: responsesPanel, forceNew: true })
          }
          onContinueDraft={(r) =>
            setOpening({ questionnaire: responsesPanel, existingResponse: r })
          }
          onViewResponse={(r) =>
            setOpening({
              questionnaire: responsesPanel,
              existingResponse: r,
              readOnly: true
            })
          }
          onDeleteDraft={(r) => void handleDeleteDraft(r)}
        />
      )}

      {opening && (
        // Full-page modal — matches the admin preview layout and gives the
        // enumerator the entire viewport (no narrow drawer). The form renders
        // its own scroll container in `fullscreen` variant. We close *only*
        // the form on dismiss/submit; the responses panel underneath stays
        // mounted so the user returns to their list, not the main grid.
        <div className="fixed inset-0 z-[1003] bg-slate-50 animate-in fade-in duration-200">
          <QuestionnaireForm
            questionnaire={opening.questionnaire}
            projectId={opening.questionnaire.projectId}
            existingResponse={opening.existingResponse}
            readOnly={opening.readOnly}
            forceNew={opening.forceNew}
            initialLocation={initialLocation}
            variant="fullscreen"
            onClose={() => {
              setOpening(null);
              // Re-read the response stats — a draft may have been saved
              // (or abandoned) while the form was open.
              setRefreshTick((t) => t + 1);
            }}
            onSubmit={() => {
              setOpening(null);
              setRefreshTick((t) => t + 1);
            }}
          />
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const QuestionnaireCard: React.FC<{
  questionnaire: Questionnaire;
  stats: QuestionnaireStats;
  onOpen: () => void;
}> = ({ questionnaire: q, stats, onOpen }) => {
  const inactive = q.isActive === false;
  const hasDraft = stats.draft > 0 && !!stats.latestDraft;
  const cta = inactive
    ? 'Inactive'
    : hasDraft
      ? 'Resume draft'
      : stats.submitted + stats.reviewed > 0
        ? 'Start new response'
        : 'Start survey';

  return (
    <button
      onClick={onOpen}
      disabled={inactive}
      className={`group text-left bg-white rounded-xl border shadow-sm hover:shadow-md transition-all p-4 flex flex-col gap-2 ${
        inactive
          ? 'border-slate-200 opacity-60 cursor-not-allowed'
          : hasDraft
            ? 'border-amber-200 hover:border-amber-400 ring-1 ring-amber-100/60'
            : 'border-slate-200 hover:border-emerald-300'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-slate-900 line-clamp-2 leading-snug">
            {q.title || '(untitled)'}
          </h3>
          {q.version && (
            <p className="text-[10px] text-slate-400 mt-0.5">v{q.version}</p>
          )}
        </div>
        {inactive ? (
          <span className="text-[9px] font-bold uppercase tracking-wider bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded shrink-0">
            Inactive
          </span>
        ) : (
          <ChevronRight
            size={16}
            className={`shrink-0 transition-all ${
              hasDraft
                ? 'text-amber-500 group-hover:text-amber-600 group-hover:translate-x-0.5'
                : 'text-slate-300 group-hover:text-emerald-600 group-hover:translate-x-0.5'
            }`}
          />
        )}
      </div>

      {q.description && (
        <p className="text-[11px] text-slate-500 line-clamp-2">{q.description}</p>
      )}

      {/* Status row — shows pills only for non-zero categories so a fresh
          card stays clean. The draft pill includes an explanatory hint
          ("edit later") so enumerators know it can be resumed. */}
      <div className="flex items-center flex-wrap gap-1.5 mt-1">
        <StatusPill
          tone="slate"
          icon={<FileText size={11} />}
          label={`${q.questions?.length || 0} question${q.questions?.length === 1 ? '' : 's'}`}
        />
        {stats.draft > 0 && (
          <StatusPill
            tone="amber"
            icon={<Save size={11} />}
            label={`${stats.draft} draft${stats.draft === 1 ? '' : 's'} • edit later`}
          />
        )}
        {stats.submitted > 0 && (
          <StatusPill
            tone="emerald"
            icon={<CheckCircle2 size={11} />}
            label={`${stats.submitted} submitted`}
          />
        )}
        {stats.reviewed > 0 && (
          <StatusPill
            tone="indigo"
            icon={<ShieldCheck size={11} />}
            label={`${stats.reviewed} reviewed`}
          />
        )}
      </div>

      {/* Call-to-action footer */}
      {!inactive && (
        <div
          className={`mt-1 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 ${
            hasDraft ? 'text-amber-700' : 'text-emerald-700'
          }`}
        >
          {cta}
          {hasDraft &&
            (() => {
              const saved =
                tsToDate(stats.latestDraft?.updatedAt) ||
                tsToDate(stats.latestDraft?.submittedAt);
              if (!saved) return null;
              return (
                <span className="font-normal normal-case text-amber-600/80 lowercase">
                  · saved {formatRelative(saved)}
                </span>
              );
            })()}
        </div>
      )}
    </button>
  );
};

type PillTone = 'slate' | 'amber' | 'emerald' | 'indigo';
const PILL_TONES: Record<PillTone, string> = {
  slate: 'bg-slate-100 text-slate-600 border-slate-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  indigo: 'bg-indigo-50 text-indigo-700 border-indigo-200'
};

const StatusPill: React.FC<{ tone: PillTone; icon: React.ReactNode; label: string }> = ({
  tone,
  icon,
  label
}) => (
  <span
    className={`inline-flex items-center gap-1 text-[10px] font-semibold border rounded-full px-2 py-0.5 ${PILL_TONES[tone]}`}
  >
    {icon}
    {label}
  </span>
);

/** Compact "5 min ago" / "2 hr ago" / fallback to absolute date for older items. */
const formatRelative = (d: Date | null | undefined): string => {
  if (!d) return '';
  const diff = Date.now() - d.getTime();
  const sec = Math.round(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day} day${day === 1 ? '' : 's'} ago`;
  return d.toLocaleDateString();
};

const EmptyState: React.FC<{
  icon: React.ReactNode;
  title: string;
  message: string;
}> = ({ icon, title, message }) => (
  <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
    <div className="flex justify-center mb-3">{icon}</div>
    <p className="text-sm font-semibold text-slate-700">{title}</p>
    <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">{message}</p>
  </div>
);

// ---------------------------------------------------------------------------
// MyResponsesPanel — full-page list of the enumerator's responses for one
// questionnaire (mirrors the admin Responses view but scoped to this user).
// Lets them: start a new response, continue editing a draft, view a
// submitted/reviewed response in read-only mode, or delete one of their own
// drafts. All data is provided by the parent's already-fetched `stats.all`
// so no extra Firestore round-trips are needed when this opens.
// ---------------------------------------------------------------------------

type ResponseFilter = 'all' | 'draft' | 'submitted' | 'reviewed';

const MyResponsesPanel: React.FC<{
  questionnaire: Questionnaire;
  stats: QuestionnaireStats;
  onClose: () => void;
  onStartNew: () => void;
  onContinueDraft: (r: QuestionnaireResponse) => void;
  onViewResponse: (r: QuestionnaireResponse) => void;
  onDeleteDraft: (r: QuestionnaireResponse) => void;
}> = ({
  questionnaire,
  stats,
  onClose,
  onStartNew,
  onContinueDraft,
  onViewResponse,
  onDeleteDraft
}) => {
  const [filter, setFilter] = useState<ResponseFilter>('all');

  const filtered = useMemo(() => {
    if (filter === 'all') return stats.all;
    return stats.all.filter((r) => r.status === filter);
  }, [stats.all, filter]);

  const totalCount = stats.all.length;

  return (
    <div className="fixed inset-0 z-[1002] bg-slate-50 flex flex-col">
      <header className="bg-white border-b border-slate-200 px-4 sm:px-6 py-3 flex items-center gap-3 shadow-sm pt-safe-top shrink-0">
        <button
          onClick={onClose}
          className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg transition-colors"
          title="Back to questionnaires"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-base sm:text-lg font-bold text-slate-900 truncate flex items-center gap-2">
            <FileText size={16} className="text-blue-600 shrink-0" />
            <span className="truncate">{questionnaire.title}</span>
          </h1>
          <p className="text-[11px] text-slate-500 truncate">
            My responses · {totalCount} total
          </p>
        </div>
        <button
          onClick={onStartNew}
          className="text-xs sm:text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 text-white px-3 sm:px-4 py-2 rounded-lg inline-flex items-center gap-1.5 transition-colors shrink-0"
          title="Start a new response"
        >
          <Plus size={15} />
          <span className="hidden sm:inline">Start new response</span>
          <span className="sm:hidden">New</span>
        </button>
      </header>

      {/* Filter tabs */}
      <div className="bg-white border-b border-slate-200 px-4 sm:px-6 py-2.5 flex items-center gap-2 overflow-x-auto">
        <div className="inline-flex rounded-md border border-slate-200 overflow-hidden text-xs font-semibold shrink-0">
          {(
            [
              ['all', 'All', totalCount],
              ['draft', 'Drafts', stats.draft],
              ['submitted', 'Submitted', stats.submitted],
              ['reviewed', 'Reviewed', stats.reviewed]
            ] as const
          ).map(([value, label, count]) => (
            <button
              key={value}
              onClick={() => setFilter(value)}
              className={`px-3 py-1.5 transition-colors ${
                filter === value
                  ? 'bg-emerald-600 text-white'
                  : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {label}
              <span
                className={`ml-1 ${
                  filter === value ? 'text-white/80' : 'text-slate-400'
                }`}
              >
                ({count})
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden px-4 sm:px-6 py-5">
        {filtered.length === 0 ? (
          totalCount === 0 ? (
            <div className="max-w-md mx-auto bg-white border border-slate-200 rounded-xl p-8 text-center">
              <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-emerald-50 flex items-center justify-center">
                <FileText size={22} className="text-emerald-500" />
              </div>
              <p className="text-sm font-semibold text-slate-800">
                You haven't started this survey yet
              </p>
              <p className="text-xs text-slate-500 mt-1 mb-4">
                Tap below to start your first response. You can save a draft at
                any time and come back to finish later.
              </p>
              <button
                onClick={onStartNew}
                className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold px-4 py-2 rounded-lg"
              >
                <Plus size={15} /> Start your first response
              </button>
            </div>
          ) : (
            <div className="text-center text-slate-500 py-12 text-sm">
              No responses match the current filter.
            </div>
          )
        ) : (
          <div className="max-w-4xl mx-auto space-y-3">
            <ul className="md:hidden space-y-3">
              {filtered.map((r, idx) => {
                const lastTouched =
                  tsToDate(r.updatedAt) || tsToDate(r.submittedAt);
                const isDraft = r.status === 'draft';
                return (
                  <li
                    key={r.id}
                    className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 space-y-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-[10px] font-bold text-slate-400 uppercase">
                        #{idx + 1}
                      </span>
                      <ResponseStatusPill status={r.status} />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                        Response ID
                      </p>
                      <ResponseIdCell id={r.id} variant="compact" />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">
                        Last updated
                      </p>
                      {lastTouched ? (
                        <>
                          <p className="text-xs text-slate-700">{fmtDate(lastTouched)}</p>
                          <p className="text-[10px] text-slate-400">
                            {formatRelative(lastTouched)}
                          </p>
                        </>
                      ) : (
                        <p className="text-xs text-slate-400 italic">—</p>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 pt-1 border-t border-slate-100">
                      {isDraft ? (
                        <>
                          <button
                            type="button"
                            onClick={() => onContinueDraft(r)}
                            className="flex-1 min-w-[8rem] text-xs font-semibold text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 px-3 py-2 rounded-lg inline-flex items-center justify-center gap-1.5"
                          >
                            <Edit3 size={14} /> Continue
                          </button>
                          <button
                            type="button"
                            onClick={() => onDeleteDraft(r)}
                            className="text-xs font-semibold text-red-700 hover:bg-red-50 border border-red-100 px-3 py-2 rounded-lg inline-flex items-center gap-1"
                            title="Delete draft"
                          >
                            <Trash2 size={14} /> Delete
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onViewResponse(r)}
                          className="w-full text-xs font-semibold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-100 px-3 py-2 rounded-lg inline-flex items-center justify-center gap-1.5"
                        >
                          <Eye size={14} /> View response
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            <div className="hidden md:block bg-white rounded-xl border border-slate-200 shadow-sm overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left border-collapse">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-3 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-wider w-10">
                    #
                  </th>
                  <th className="px-3 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Response ID
                  </th>
                  <th className="px-3 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Last Updated
                  </th>
                  <th className="px-3 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-3 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-wider text-right whitespace-nowrap">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((r, idx) => {
                  const lastTouched =
                    tsToDate(r.updatedAt) || tsToDate(r.submittedAt);
                  const isDraft = r.status === 'draft';
                  return (
                    <tr key={r.id} className="hover:bg-slate-50/60">
                      <td className="px-3 py-3 text-xs text-slate-400">{idx + 1}</td>
                      <td className="px-3 py-3 max-w-[14rem]">
                        <ResponseIdCell id={r.id} variant="compact" />
                      </td>
                      <td className="px-3 py-3 text-xs text-slate-700 whitespace-nowrap">
                        {lastTouched ? (
                          <div>
                            <div className="text-slate-700">
                              {fmtDate(lastTouched)}
                            </div>
                            <div className="text-[10px] text-slate-400">
                              {formatRelative(lastTouched)}
                            </div>
                          </div>
                        ) : (
                          <span className="text-slate-400 italic">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <ResponseStatusPill status={r.status} />
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-end gap-1 flex-wrap">
                          {isDraft ? (
                            <>
                              <button
                                onClick={() => onContinueDraft(r)}
                                className="text-xs font-semibold text-amber-700 hover:bg-amber-50 px-2 py-1 rounded inline-flex items-center gap-1"
                                title="Continue editing this draft"
                              >
                                <Edit3 size={12} /> Continue
                              </button>
                              <button
                                onClick={() => onDeleteDraft(r)}
                                className="text-xs font-semibold text-red-700 hover:bg-red-50 px-2 py-1 rounded"
                                title="Delete draft"
                              >
                                <Trash2 size={12} />
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => onViewResponse(r)}
                              className="text-xs font-semibold text-blue-700 hover:bg-blue-50 px-2 py-1 rounded inline-flex items-center gap-1"
                              title="View this response"
                            >
                              <Eye size={12} /> View
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const ResponseStatusPill: React.FC<{
  status: QuestionnaireResponse['status'];
}> = ({ status }) => {
  const styles =
    status === 'reviewed'
      ? 'bg-indigo-100 text-indigo-700'
      : status === 'submitted'
        ? 'bg-emerald-100 text-emerald-700'
        : 'bg-amber-100 text-amber-700';
  return (
    <span
      className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${styles}`}
    >
      {status}
    </span>
  );
};
