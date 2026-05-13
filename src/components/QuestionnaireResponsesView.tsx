import React, { Suspense, useEffect, useMemo, useState } from 'react';
import {
  collection,
  getDocs,
  query,
  where,
  doc,
  updateDoc,
  deleteDoc,
  serverTimestamp
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { Question, Questionnaire, QuestionnaireResponse } from '../types';
import { useAuth } from './AuthProvider';
import { useOptimizedFeatures } from '../hooks/useOptimizedFeatures';
import wardsData from '../data/ccc_wards.json';
import { Map as MapIcon, ChevronDown, ChevronUp } from 'lucide-react';
import type { SurveyLocationMarker } from './MapComponent';

// Lazy: MapComponent transitively pulls react-leaflet + leaflet (~150 KB) so
// keep it out of the responses-view's initial chunk. Admins only pay the
// cost when this view actually opens.
const MapComponent = React.lazy(() =>
  import('./MapComponent').then((m) => ({ default: m.MapComponent }))
);
import {
  ArrowLeft,
  FileText,
  Search,
  RefreshCw,
  MapPin,
  Trash2,
  Eye,
  X,
  CheckCircle2,
  AlertCircle,
  FileSpreadsheet,
  ShieldCheck,
  Clock,
  IdCard,
  Satellite,
  Users
} from 'lucide-react';
import {
  buildResponsesTable,
  downloadResponsesCsv,
  fmtDate,
  tsToDate
} from '../lib/responseExport';
import { ResponseIdCell } from './ResponseIdCell';

interface QuestionnaireResponsesViewProps {
  questionnaire: Questionnaire;
  onClose: () => void;
}

type StatusFilter = 'all' | 'draft' | 'submitted' | 'reviewed';

export const QuestionnaireResponsesView: React.FC<QuestionnaireResponsesViewProps> = ({
  questionnaire,
  onClose
}) => {
  const { user } = useAuth();
  const [responses, setResponses] = useState<QuestionnaireResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<QuestionnaireResponse | null>(null);

  // Pull the same feature set the geospatial-survey tab uses so admins viewing
  // this questionnaire's responses get the full map context (wards, points,
  // lines, polygons) in the embedded preview below. `'admin'` mode mirrors
  // the load behaviour of the main map for admin users; non-admin viewers
  // are filtered out before reaching this view, so passing `'admin'`
  // unconditionally is safe here.
  const { features: mapFeatures } = useOptimizedFeatures({
    mode: 'admin',
    userUid: user?.uid,
    userEmail: user?.email ?? undefined,
    assignedWards: [],
    adminRefreshKey: 0,
    enumeratorPersistRefreshKey: 0
  });

  const fetchResponses = async () => {
    try {
      setLoading(true);
      setFetchError(null);
      const qRef = query(
        collection(db, 'questionnaireResponses'),
        where('questionnaireId', '==', questionnaire.id)
      );
      const snap = await getDocs(qRef);
      const list: QuestionnaireResponse[] = [];
      snap.forEach((d) =>
        list.push({ ...(d.data() as QuestionnaireResponse), id: d.id })
      );
      list.sort((a, b) => {
        const ta = tsToDate(a.submittedAt)?.getTime() ?? 0;
        const tb = tsToDate(b.submittedAt)?.getTime() ?? 0;
        return tb - ta;
      });
      setResponses(list);
    } catch (error) {
      console.error('Error fetching responses:', error);
      setFetchError(
        error instanceof Error ? error.message : 'Failed to load responses.'
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchResponses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionnaire.id]);

  // Project this questionnaire's responses into the marker shape the map's
  // "HH Survey Location" layer expects. Scoped to *this* questionnaire so
  // the embedded preview only shows points relevant to what the admin is
  // looking at right now (the parent geospatial map shows all points,
  // across all questionnaires).
  const surveyLocationMarkers = useMemo<SurveyLocationMarker[]>(() => {
    const out: SurveyLocationMarker[] = [];
    for (const r of responses) {
      // Prefer the deliberate `submissionLocation` (has accuracy + capturedAt);
      // fall back to the older `location` field for older / draft responses.
      const sub = (r as any).submissionLocation as
        | { lat?: number; lng?: number; accuracy?: number; capturedAt?: unknown }
        | undefined;
      const loc = r.location;
      let lat: number | undefined;
      let lng: number | undefined;
      let accuracy: number | undefined;
      let capturedAt: unknown;
      if (
        sub &&
        typeof sub.lat === 'number' &&
        typeof sub.lng === 'number' &&
        Number.isFinite(sub.lat) &&
        Number.isFinite(sub.lng)
      ) {
        lat = sub.lat;
        lng = sub.lng;
        accuracy = typeof sub.accuracy === 'number' ? sub.accuracy : undefined;
        capturedAt = sub.capturedAt;
      } else if (
        loc &&
        typeof loc.lat === 'number' &&
        typeof loc.lng === 'number' &&
        Number.isFinite(loc.lat) &&
        Number.isFinite(loc.lng)
      ) {
        lat = loc.lat;
        lng = loc.lng;
      }
      if (typeof lat !== 'number' || typeof lng !== 'number') continue;
      out.push({
        id: r.id,
        lat,
        lng,
        accuracy,
        capturedAt,
        respondentName: r.respondentName,
        respondentEmail: r.respondentEmail,
        questionnaireId: r.questionnaireId,
        questionnaireTitle: questionnaire.title,
        status: r.status,
        submittedAt: r.submittedAt,
        ward: r.location?.ward
      });
    }
    return out;
  }, [responses, questionnaire.title]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return responses.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (!s) return true;
      // Build a wide haystack: the obvious metadata (name, email, ward, id,
      // status) plus the *values* of every enumerator-info field and every
      // answer. Object/array values are JSON-stringified so checkbox/radio
      // selections and matrix answers are still searchable. This makes the
      // search input a quick "find any response containing X" tool without
      // requiring admins to know which column the term lives in.
      const parts: string[] = [];
      const push = (v: unknown) => {
        if (v == null) return;
        if (typeof v === 'string' || typeof v === 'number') parts.push(String(v));
        else {
          try { parts.push(JSON.stringify(v)); } catch { /* skip */ }
        }
      };
      push(r.respondentName);
      push(r.respondentEmail);
      push(r.respondentId);
      push(r.location?.ward);
      push(r.id);
      push(r.status);
      if (r.enumeratorInfo) for (const v of Object.values(r.enumeratorInfo)) push(v);
      if (r.responses) for (const v of Object.values(r.responses)) push(v);
      return parts.join(' ').toLowerCase().includes(s);
    });
  }, [responses, statusFilter, search]);

  const counts = useMemo(() => {
    const c = { all: responses.length, draft: 0, submitted: 0, reviewed: 0 };
    for (const r of responses) {
      if (r.status === 'draft') c.draft++;
      else if (r.status === 'submitted') c.submitted++;
      else if (r.status === 'reviewed') c.reviewed++;
    }
    return c;
  }, [responses]);

  /**
   * Aggregate per-enumerator activity. Used by the sidebar to show admins
   * who is producing how many responses (and in what state), so they can
   * spot inactive enumerators, fraud, or training needs at a glance.
   * Sorted descending by total, with the most active enumerator first.
   */
  const enumeratorBreakdown = useMemo(() => {
    const map = new Map<
      string,
      {
        uid: string;
        name: string;
        email?: string;
        draft: number;
        submitted: number;
        reviewed: number;
        total: number;
        lastSeen: number;
      }
    >();
    for (const r of responses) {
      const uid = r.respondentId || `__name__:${r.respondentName || 'Unknown'}`;
      const cur =
        map.get(uid) || {
          uid,
          name: r.respondentName || 'Unknown',
          email: r.respondentEmail,
          draft: 0,
          submitted: 0,
          reviewed: 0,
          total: 0,
          lastSeen: 0
        };
      if (r.status === 'draft') cur.draft += 1;
      else if (r.status === 'reviewed') cur.reviewed += 1;
      else cur.submitted += 1;
      cur.total += 1;
      const t =
        tsToDate(r.updatedAt)?.getTime() ??
        tsToDate(r.submittedAt)?.getTime() ??
        0;
      if (t > cur.lastSeen) cur.lastSeen = t;
      // Prefer the most-recently-seen display name / email if any row
      // happens to have richer profile data than the first one we saw.
      if (!cur.email && r.respondentEmail) cur.email = r.respondentEmail;
      if ((cur.name === 'Unknown' || !cur.name) && r.respondentName) {
        cur.name = r.respondentName;
      }
      map.set(uid, cur);
    }
    return Array.from(map.values()).sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      return b.lastSeen - a.lastSeen;
    });
  }, [responses]);

  const markReviewed = async (r: QuestionnaireResponse) => {
    if (!user) return;
    try {
      await updateDoc(doc(db, 'questionnaireResponses', r.id), {
        status: 'reviewed',
        reviewedAt: serverTimestamp(),
        reviewedBy: user.email || user.uid
      });
      await fetchResponses();
      if (selected?.id === r.id) {
        setSelected({
          ...r,
          status: 'reviewed',
          reviewedBy: user.email || user.uid
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, 'questionnaireResponses');
    }
  };

  const handleDelete = async (r: QuestionnaireResponse) => {
    if (!confirm('Delete this response? This cannot be undone.')) return;
    try {
      await deleteDoc(doc(db, 'questionnaireResponses', r.id));
      setResponses((prev) => prev.filter((x) => x.id !== r.id));
      if (selected?.id === r.id) setSelected(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, 'questionnaireResponses');
    }
  };

  const handleExportCsv = () => {
    if (filtered.length === 0) {
      alert('Nothing to export — no responses match the current filter.');
      return;
    }
    downloadResponsesCsv(questionnaire, filtered);
  };

  return (
    <div className="fixed inset-0 z-[1006] bg-slate-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center gap-3 shadow-sm">
        <button
          onClick={onClose}
          className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg transition-colors"
          title="Back to questionnaires"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold text-slate-900 truncate flex items-center gap-2">
            <FileText size={18} className="text-blue-600" />
            {questionnaire.title}
          </h1>
          <p className="text-xs text-slate-500">
            Survey responses • v{questionnaire.version || '1.0'} •{' '}
            {questionnaire.questions?.length || 0} questions
          </p>
        </div>
        <button
          onClick={() => void fetchResponses()}
          className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg transition-colors"
          title="Refresh"
        >
          <RefreshCw size={16} />
        </button>
        <button
          onClick={handleExportCsv}
          disabled={loading || filtered.length === 0}
          className="px-3 py-2 text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg flex items-center gap-1.5 transition-colors"
          title="Download all matching responses as a CSV file"
        >
          <FileSpreadsheet size={15} /> Export CSV ({filtered.length})
        </button>
      </header>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-6">
        {fetchError && (
          <div className="mb-4 max-w-5xl bg-red-50 border border-red-200 text-red-800 rounded-lg px-4 py-3 flex items-start gap-3">
            <AlertCircle size={18} className="shrink-0 mt-0.5" />
            <div className="flex-1 text-sm">
              <p className="font-semibold">Could not load responses.</p>
              <p className="text-xs text-red-700/80 mt-0.5">{fetchError}</p>
            </div>
            <button
              onClick={() => void fetchResponses()}
              className="text-xs font-semibold text-red-700 hover:text-red-900 underline"
            >
              Retry
            </button>
          </div>
        )}

        {loading ? (
          <div className="text-center text-slate-500 py-20">Loading responses…</div>
        ) : responses.length === 0 ? (
          // True empty state — no responses exist at all for this questionnaire.
          // We hide the search / filter toolbar entirely in this case because
          // there's nothing to search through and an empty toolbar above an
          // illustration would look broken.
          <div className="text-center text-slate-500 py-20">
            <FileText size={48} className="mx-auto mb-4 text-slate-300" />
            <p className="font-medium">No responses yet for this questionnaire</p>
            <p className="text-sm">Responses will appear here as enumerators submit them.</p>
          </div>
        ) : (
        // Two-column layout on xl+: main column flexes to fill all
        // remaining horizontal space (no `max-w-*` cap) so the sidebar
        // gets pushed flush against the right edge of the viewport
        // instead of leaving dead whitespace there. The response table
        // and CSV preview inside scroll horizontally as needed, so
        // dropping the cap doesn't visually distort them. Below xl
        // the columns stack vertically.
        <div className="flex flex-col xl:flex-row gap-6">
          <div className="flex-1 min-w-0">
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            {/* Toolbar — search + status filter live inside the card so
                they're visually tied to the response list they affect. */}
            <div className="px-3 sm:px-4 py-3 border-b border-slate-200 bg-slate-50/40 flex flex-wrap items-center gap-3">
              <div className="relative flex-1 min-w-[220px] max-w-xl">
                <Search
                  size={14}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
                />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search across enumerator, email, ward, ID, status, info fields, and answers…"
                  className="w-full pl-9 pr-9 py-2 text-sm border border-slate-200 bg-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded"
                    title="Clear search"
                    aria-label="Clear search"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              <div className="inline-flex rounded-md border border-slate-200 overflow-hidden text-xs font-semibold bg-white">
                {(
                  [
                    ['all', 'All', counts.all],
                    ['submitted', 'Submitted', counts.submitted],
                    ['reviewed', 'Reviewed', counts.reviewed],
                    ['draft', 'Draft', counts.draft]
                  ] as const
                ).map(([value, label, count]) => (
                  <button
                    key={value}
                    onClick={() => setStatusFilter(value)}
                    className={`px-3 py-1.5 transition-colors ${
                      statusFilter === value
                        ? 'bg-blue-600 text-white'
                        : 'bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {label}
                    <span
                      className={`ml-1 ${
                        statusFilter === value ? 'text-white/80' : 'text-slate-400'
                      }`}
                    >
                      ({count})
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {filtered.length === 0 ? (
              // Filters / search exclude everything — show inline empty
              // state inside the card so the toolbar above (and the clear
              // affordances on it) remain usable.
              <div className="px-6 py-12 text-center text-slate-500">
                <Search size={28} className="mx-auto mb-3 text-slate-300" />
                <p className="text-sm font-semibold text-slate-700">
                  No responses match the current filters
                </p>
                <p className="text-xs mt-1">
                  Try a different search term, clear the search, or change the status filter.
                </p>
                {(search || statusFilter !== 'all') && (
                  <button
                    onClick={() => {
                      setSearch('');
                      setStatusFilter('all');
                    }}
                    className="mt-3 text-xs font-semibold text-blue-700 hover:text-blue-900 underline"
                  >
                    Reset filters
                  </button>
                )}
              </div>
            ) : (
              <>
            {/* Fixed-height scrollable box. Sized so roughly 10 rows fit
                comfortably; once more rows pile up the body scrolls inside
                this container while the page stays still. The thead is
                sticky so column titles remain visible while scrolling.
                `qc-panel-scroll` forces a visible (non-overlay) scrollbar
                on Windows so admins always know more rows are below. */}
            <div className="qc-panel-scroll overflow-y-auto max-h-[640px]">
              <table className="w-full text-left border-collapse">
                <thead className="bg-slate-50 sticky top-0 z-10 shadow-[0_1px_0_0_rgba(15,23,42,0.08)]">
                <tr>
                  <th className="px-3 py-2 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    #
                  </th>
                  <th className="px-3 py-2 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Response ID
                  </th>
                  <th className="px-3 py-2 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Submitted
                  </th>
                  <th className="px-3 py-2 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Enumerator
                  </th>
                  <th className="px-3 py-2 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Location
                  </th>
                  <th className="px-3 py-2 text-[10px] font-bold text-slate-400 uppercase tracking-wider text-center">
                    Consent
                  </th>
                  <th className="px-3 py-2 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-3 py-2 text-[10px] font-bold text-slate-400 uppercase tracking-wider text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((r, idx) => (
                  <tr key={r.id} className="hover:bg-slate-50/60">
                    <td className="px-3 py-1.5 text-xs text-slate-400">{idx + 1}</td>
                    <td className="px-3 py-1.5">
                      <ResponseIdCell id={r.id} />
                    </td>
                    <td className="px-3 py-1.5 text-xs text-slate-700">
                      {fmtDate(r.submittedAt) || (
                        <span className="text-slate-400 italic">—</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="text-[13px] font-semibold text-slate-800 leading-tight">
                        {r.respondentName || (
                          <span className="text-slate-400 italic">Unknown</span>
                        )}
                      </div>
                      {r.respondentEmail && (
                        <div className="text-[10px] text-slate-400 leading-tight">
                          {r.respondentEmail}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-slate-700">
                      {r.location ? (
                        <span className="inline-flex items-center gap-1">
                          <MapPin size={11} className="text-slate-400" />
                          {r.location.lat.toFixed(4)}, {r.location.lng.toFixed(4)}
                          {r.location.ward && (
                            <span className="text-slate-400 ml-1">
                              ({r.location.ward})
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-slate-400 italic">—</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      {r.consentGranted ? (
                        <CheckCircle2
                          size={14}
                          className="text-emerald-500 inline"
                        />
                      ) : (
                        <span className="text-[10px] text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      <StatusPill status={r.status} />
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => setSelected(r)}
                          className="text-xs font-semibold text-blue-700 hover:bg-blue-50 px-2 py-1 rounded inline-flex items-center gap-1"
                        >
                          <Eye size={12} /> View
                        </button>
                        <button
                          onClick={() => void handleDelete(r)}
                          className="text-xs font-semibold text-red-700 hover:bg-red-50 px-2 py-1 rounded"
                          title="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <div className="px-4 py-2 text-[11px] text-slate-500 border-t border-slate-200 bg-slate-50/60 flex items-center justify-between">
              <span>
                Showing <span className="font-bold text-slate-700">{filtered.length}</span> of{' '}
                <span className="font-bold text-slate-700">{responses.length}</span> response
                {responses.length === 1 ? '' : 's'}
                {search && (
                  <span className="text-slate-400">
                    {' '}
                    · matching <span className="font-mono">"{search}"</span>
                  </span>
                )}
              </span>
              {filtered.length > 10 && (
                <span className="text-slate-400 italic">Scroll for more</span>
              )}
            </div>
            </>
            )}
          </div>

          {/* CSV export preview — same columns, same cell formatting as the
              downloaded file, scoped to the most recent 100 responses so
              preview rendering stays snappy even on questionnaires with
              thousands of accumulated rows. */}
          <CsvPreview questionnaire={questionnaire} responses={filtered} />
          </div>

          {/* Right-side sidebar: enumerator-wise total counts followed by
              the embedded geospatial preview. Stacks below the main column
              on small/medium viewports (`xl:` breakpoint flips to a
              side-by-side flex row above). The map is rendered as the
              second item in this column (instead of as a full-width row
              below the layout) so it sits directly under the "By
              enumerator" panel as a spatial summary, leaving the
              response table + CSV preview unconstrained on the left.

              Width is `xl:w-[420px]` (was 320px) so the previously empty
              right margin gets reclaimed for the map. The aside is also
              a flex column with the map element flagged `flex-1`, so on
              tall viewports the map stretches to fill all remaining
              vertical space below the enumerator card instead of leaving
              dead whitespace at the bottom of the page. */}
          <aside className="xl:w-[420px] xl:shrink-0 flex flex-col gap-6">
            <EnumeratorBreakdownPanel enumerators={enumeratorBreakdown} />
            {/* Same data + controls as the main "Geospatial Survey" tab,
                landmark layer off by default. */}
            <ResponsesMapPanel features={mapFeatures} surveyLocations={surveyLocationMarkers} />
          </aside>
        </div>
        )}
      </div>

      {/* Detail dialog */}
      {selected && (
        <ResponseDetailDialog
          questionnaire={questionnaire}
          response={selected}
          onClose={() => setSelected(null)}
          onMarkReviewed={() => void markReviewed(selected)}
          onDelete={() => void handleDelete(selected)}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// ResponsesMapPanel — full-width geospatial preview rendered below the
// response table + CSV preview + enumerator-breakdown row. Reuses the
// production `MapComponent` so admins get the exact same ward/feature
// layers, base maps, and layer controls that the "Geospatial Survey" tab
// exposes. Differences:
//   - Landmark layer starts off (admins reviewing submissions don't need
//     the imported landmark dataset cluttering the view; they can toggle
//     it back on via the layer panel).
//   - All feature-mutation paths are disabled: `addFeatureType={null}`
//     and the select / move callbacks are no-ops, since this is a
//     read-only preview, not the editing surface.
// ---------------------------------------------------------------------------
// Persist the show/hide preference per browser so admins who don't care
// about the map don't have to dismiss it every time they open this view.
const MAP_VISIBLE_STORAGE_KEY = 'eqms_responses_map_visible_v1';

const ResponsesMapPanel: React.FC<{
  features: any[];
  surveyLocations: SurveyLocationMarker[];
}> = ({ features, surveyLocations }) => {
  // Default visible — most admins want to see the spatial summary at a
  // glance — but respect a previously-stored "off" preference.
  const [visible, setVisible] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try {
      const raw = window.localStorage.getItem(MAP_VISIBLE_STORAGE_KEY);
      return raw === null ? true : raw === '1';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(MAP_VISIBLE_STORAGE_KEY, visible ? '1' : '0');
    } catch {
      /* localStorage may be blocked (private mode); silent fallback */
    }
  }, [visible]);

  // When hidden, collapse to just a slim header — keeps the toggle
  // visible and discoverable without claiming sidebar real estate.
  if (!visible) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <button
          type="button"
          onClick={() => setVisible(true)}
          className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-slate-50 transition-colors"
          title="Show geospatial preview"
        >
          <MapIcon size={14} className="text-blue-600 shrink-0" />
          <h3 className="font-semibold text-slate-800 text-xs">Geospatial preview</h3>
          {surveyLocations.length > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-slate-700 bg-slate-100 border border-slate-300 rounded-full px-1.5 py-0.5">
              <span
                className="inline-block w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: '#374151' }}
                aria-hidden
              />
              {surveyLocations.length}
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium text-blue-600">
            Show <ChevronDown size={12} />
          </span>
        </button>
      </div>
    );
  }

  return (
    // `flex-1 + flex flex-col` — when this panel is placed in a flex
    // column sidebar (as we do in the Responses view), this lets the map
    // body absorb all leftover vertical space below the enumerator card
    // instead of leaving empty whitespace at the bottom of the page.
    // `min(580px, 64vh)` is a balanced floor — large enough to read ward
    // context comfortably, but trimmed down from earlier so the map
    // doesn't dominate the page or push CSV preview / table off-screen
    // on smaller laptops.
    <div className="flex-1 min-h-[min(580px,64vh)] bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
      <div className="px-3 py-2 border-b border-slate-200 flex items-center gap-2 shrink-0">
        <MapIcon size={14} className="text-blue-600 shrink-0" />
        <h3 className="font-semibold text-slate-800 text-xs">Geospatial preview</h3>
        {surveyLocations.length > 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-slate-700 bg-slate-100 border border-slate-300 rounded-full px-1.5 py-0.5">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: '#374151' }}
              aria-hidden
            />
            {surveyLocations.length}
          </span>
        )}
        <button
          type="button"
          onClick={() => setVisible(false)}
          className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded px-1.5 py-1 transition-colors"
          title="Hide geospatial preview"
        >
          Hide <ChevronUp size={12} />
        </button>
      </div>
      {/* `flex-1` body — Leaflet still needs an explicit size, but
          `flex-1` inside a flex column gives it a real numeric height
          (the parent's height minus the header). On tall viewports the
          map grows to fill all leftover sidebar space; on shorter ones
          the wrapper's viewport-relative min-height keeps it readable
          without overflowing the fold. */}
      <div className="relative w-full flex-1 min-h-[min(540px,58vh)]">
        <Suspense
          fallback={
            <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm">
              Loading map…
            </div>
          }
        >
          <MapComponent
            features={features}
            wards={wardsData}
            onFeatureSelect={() => {}}
            addFeatureType={null}
            defaultShowLandmarks={false}
            surveyLocations={surveyLocations}
          />
        </Suspense>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// EnumeratorBreakdownPanel — right-side sidebar listing each enumerator who
// has produced a response for this questionnaire, with their per-status
// breakdown (draft / submitted / reviewed) and a relative "last seen"
// timestamp. Sorted with most-active enumerator at the top. Lets admins
// spot inactive surveyors, flag fraud (huge counts from one person),
// and prioritise review queues without leaving the page.
// ---------------------------------------------------------------------------

interface EnumeratorBreakdownEntry {
  uid: string;
  name: string;
  email?: string;
  draft: number;
  submitted: number;
  reviewed: number;
  total: number;
  lastSeen: number;
}

const EnumeratorBreakdownPanel: React.FC<{
  enumerators: EnumeratorBreakdownEntry[];
}> = ({ enumerators }) => {
  const totalResponses = enumerators.reduce((s, e) => s + e.total, 0);

  return (
    // Compact card — same visual rhythm as the Geospatial Survey's "By
    // enumerator" QC summary so admins recognise the format across both
    // tabs. Header on top, single dense table below with one row per
    // enumerator showing per-status counts (D/S/R) + total.
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden xl:sticky xl:top-0 p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Users size={14} className="text-slate-600 shrink-0" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600">
          By enumerator
        </span>
        <span className="ml-auto text-[10px] text-slate-400 tabular-nums">
          {enumerators.length} · {totalResponses} resp.
        </span>
      </div>

      {enumerators.length === 0 ? (
        <p className="text-[10px] text-slate-400 italic px-1 py-2">
          No enumerator activity yet.
        </p>
      ) : (
        <div className="qc-panel-scroll max-h-[420px] overflow-y-auto rounded-lg border border-slate-100">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="bg-slate-50 text-slate-500">
                <th className="text-left px-1.5 py-1 font-semibold">Name</th>
                <th
                  className="text-center px-0.5 py-1 w-6 font-semibold text-amber-600"
                  title="Drafts"
                >
                  D
                </th>
                <th
                  className="text-center px-0.5 py-1 w-6 font-semibold text-blue-600"
                  title="Submitted"
                >
                  S
                </th>
                <th
                  className="text-center px-0.5 py-1 w-6 font-semibold text-emerald-600"
                  title="Reviewed"
                >
                  R
                </th>
                <th
                  className="text-center px-0.5 py-1 w-7 font-semibold text-slate-700"
                  title="Total responses (D+S+R)"
                >
                  Σ
                </th>
                <th
                  className="text-right px-1 py-1 font-semibold text-slate-400"
                  title="Last activity"
                >
                  Last
                </th>
              </tr>
            </thead>
            <tbody>
              {enumerators.map((e) => (
                <tr
                  key={e.uid}
                  className="border-t border-slate-100 hover:bg-slate-50/60"
                  title={e.email || undefined}
                >
                  <td className="px-1.5 py-1 text-slate-800 truncate max-w-[8rem]">
                    {e.name || <span className="text-slate-400 italic">Unknown</span>}
                  </td>
                  <td className="text-center py-1 font-semibold text-amber-600 tabular-nums">
                    {e.draft || ''}
                  </td>
                  <td className="text-center py-1 font-semibold text-blue-600 tabular-nums">
                    {e.submitted || ''}
                  </td>
                  <td className="text-center py-1 font-semibold text-emerald-600 tabular-nums">
                    {e.reviewed || ''}
                  </td>
                  <td className="text-center py-1 font-bold text-slate-700 tabular-nums">
                    {e.total}
                  </td>
                  <td className="text-right px-1 py-1 text-slate-400 tabular-nums whitespace-nowrap">
                    {e.lastSeen > 0 ? formatRelativeTime(e.lastSeen) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

/** "5 min ago" / "2 hr ago" / falls back to a local date string. */
const formatRelativeTime = (ms: number): string => {
  if (!ms || !Number.isFinite(ms)) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return new Date(ms).toLocaleDateString();
  const sec = Math.round(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day} day${day === 1 ? '' : 's'} ago`;
  return new Date(ms).toLocaleDateString();
};

// ---------------------------------------------------------------------------
// CsvPreview — read-only preview of the data that would be exported as CSV.
// Uses the same `buildResponsesTable` helper as the downloader, so admins
// can verify column names, ordering, and per-cell stringification before
// they ever hit "Export CSV". Sized to fit ~20 rows comfortably, scrolls
// vertically *and* horizontally past that. Caps the rendered set at the
// most recent 100 responses so a several-thousand-row questionnaire
// doesn't make the DOM enormous; admins still get the full set in the
// downloaded file.
// ---------------------------------------------------------------------------

const PREVIEW_LIMIT = 100;

const CsvPreview: React.FC<{
  questionnaire: Questionnaire;
  responses: QuestionnaireResponse[];
}> = ({ questionnaire, responses }) => {
  // Show the *latest* 100 by submittedAt (parent already pre-sorts that way).
  const slice = useMemo(() => responses.slice(0, PREVIEW_LIMIT), [responses]);
  const { header, rows } = useMemo(
    () => buildResponsesTable(questionnaire, slice),
    [questionnaire, slice]
  );

  if (rows.length === 0) return null;

  const truncated = responses.length > PREVIEW_LIMIT;

  return (
    <div className="mt-6 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/60 flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
            <FileSpreadsheet size={15} className="text-emerald-600" />
            CSV export preview
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Exact layout of the downloaded file. Showing latest{' '}
            <span className="font-bold text-slate-700">{rows.length}</span> of{' '}
            <span className="font-bold text-slate-700">{responses.length}</span>{' '}
            response{responses.length === 1 ? '' : 's'}
            {truncated && (
              <> · older rows hidden from preview but included in the export</>
            )}
            {' · '}
            {header.length} column{header.length === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      {/* Fixed-height scrollable viewport. Bumped to 720 px so ~26 rows
          + header fit comfortably (rows are roughly 24 px tall in
          monospace) — gives admins a longer preview before vertical
          scroll kicks in. Horizontal scroll still kicks in automatically
          when many enumerator-info / question columns are present. */}
      <div className="qc-panel-scroll overflow-auto max-h-[720px]">
        <table className="w-full text-[11px] border-collapse">
          <thead className="bg-slate-50 sticky top-0 z-10 shadow-[0_1px_0_0_rgba(15,23,42,0.08)]">
            <tr>
              <th
                scope="col"
                className="px-2 py-1.5 text-[9px] font-bold text-slate-400 uppercase tracking-wider text-right border-r border-slate-200 sticky left-0 bg-slate-50 z-20"
              >
                #
              </th>
              {header.map((h, i) => (
                <th
                  key={i}
                  scope="col"
                  className="px-2 py-1.5 text-[9px] font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap border-r border-slate-100 last:border-r-0"
                  title={h}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr
                key={ri}
                className="even:bg-slate-50/40 hover:bg-blue-50/40 transition-colors"
              >
                <td className="px-2 py-1 text-slate-400 text-right border-r border-slate-200 font-mono tabular-nums sticky left-0 bg-inherit z-10">
                  {ri + 1}
                </td>
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className="px-2 py-1 text-slate-700 whitespace-nowrap border-r border-slate-100 last:border-r-0 font-mono"
                    title={cell}
                  >
                    {cell || <span className="text-slate-300">·</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="px-4 py-2 text-[11px] text-slate-500 border-t border-slate-200 bg-slate-50/40 flex items-center justify-between flex-wrap gap-2">
        <span>
          {rows.length > 20 && (
            <span className="text-slate-400 italic">Scroll for more rows · </span>
          )}
          Scroll horizontally to see all {header.length} columns.
        </span>
        {truncated && (
          <span className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">
            Preview limited to the most recent {PREVIEW_LIMIT} rows
          </span>
        )}
      </div>
    </div>
  );
};

const StatusPill: React.FC<{ status: QuestionnaireResponse['status'] }> = ({
  status
}) => {
  const styles =
    status === 'reviewed'
      ? 'bg-emerald-100 text-emerald-700'
      : status === 'submitted'
        ? 'bg-blue-100 text-blue-700'
        : 'bg-slate-200 text-slate-600';
  return (
    <span
      className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${styles}`}
    >
      {status}
    </span>
  );
};

// ---------------------------------------------------------------------------
// ResponseDetailDialog — full read-only view of one response
// ---------------------------------------------------------------------------

const ResponseDetailDialog: React.FC<{
  questionnaire: Questionnaire;
  response: QuestionnaireResponse;
  onClose: () => void;
  onMarkReviewed: () => void;
  onDelete: () => void;
}> = ({
  questionnaire,
  response,
  onClose,
  onMarkReviewed,
  onDelete
}) => {
  const enumFields = questionnaire.enumeratorInfo?.fields || [];
  const questions = (questionnaire.questions || []).filter(
    (q) => q.type !== 'section'
  );

  return (
    <div className="fixed inset-0 z-[1008] bg-slate-900/60 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col">
        <header className="px-6 py-4 border-b border-slate-200 flex items-start justify-between bg-gradient-to-r from-blue-50 to-indigo-50 rounded-t-xl">
          <div className="min-w-0">
            <div className="text-[10px] font-bold text-blue-700 uppercase tracking-wider mb-1">
              Response Detail
            </div>
            <h3 className="font-bold text-slate-900">
              {response.respondentName || response.respondentEmail || 'Unknown'}
            </h3>
            <p className="text-xs text-slate-500">
              {fmtDate(response.submittedAt) || 'unsubmitted'} • {response.id}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-500 hover:bg-white/60 rounded"
          >
            <X size={20} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Metadata */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <MetaTile
              icon={<StatusPillIcon status={response.status} />}
              label="Status"
              value={response.status}
            />
            <MetaTile
              icon={<ShieldCheck size={14} className="text-emerald-500" />}
              label="Consent"
              value={
                response.consentGranted
                  ? `Granted${
                      response.consentGrantedAt
                        ? ` (${fmtDate(response.consentGrantedAt)})`
                        : ''
                    }`
                  : 'Not granted'
              }
            />
            {response.location && (
              <MetaTile
                icon={<MapPin size={14} className="text-indigo-500" />}
                label="Location"
                value={`${response.location.lat.toFixed(6)}, ${response.location.lng.toFixed(6)}${
                  response.location.ward ? ` (Ward: ${response.location.ward})` : ''
                }`}
              />
            )}
            {response.reviewedAt && (
              <MetaTile
                icon={<Clock size={14} className="text-slate-500" />}
                label="Reviewed"
                value={`${fmtDate(response.reviewedAt)}${
                  response.reviewedBy ? ` by ${response.reviewedBy}` : ''
                }`}
              />
            )}
            {response.submissionLocation && (
              <MetaTile
                icon={<Satellite size={14} className="text-emerald-500" />}
                label="Submission GPS"
                value={`${response.submissionLocation.lat.toFixed(6)}, ${response.submissionLocation.lng.toFixed(6)} (±${response.submissionLocation.accuracy.toFixed(1)} m)`}
              />
            )}
          </div>

          {/* Enumerator info */}
          {enumFields.length > 0 && (
            <section>
              <h4 className="text-xs font-bold text-indigo-700 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <IdCard size={13} />
                {questionnaire.enumeratorInfo?.title || 'Enumerator Information'}
              </h4>
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <tbody>
                    {enumFields.map((f) => (
                      <tr
                        key={f.id}
                        className="border-t first:border-t-0 border-slate-100"
                      >
                        <th className="text-left text-xs font-semibold text-slate-600 align-top bg-slate-50 px-3 py-2 w-1/3">
                          {f.question || f.key || f.id}
                        </th>
                        <td className="px-3 py-2 text-slate-800">
                          {formatAnswerForDisplay(
                            response.enumeratorInfo?.[f.id],
                            f
                          ) || <span className="text-slate-400 italic">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* Survey answers */}
          <section>
            <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">
              Survey Responses ({questions.length})
            </h4>
            {questions.length === 0 ? (
              <p className="text-sm text-slate-400 italic">No questions defined.</p>
            ) : (
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <tbody>
                    {questions.map((q, i) => (
                      <tr
                        key={q.id}
                        className="border-t first:border-t-0 border-slate-100"
                      >
                        <th className="text-left text-xs font-semibold text-slate-600 align-top bg-slate-50 px-3 py-2 w-2/5">
                          <span className="text-slate-400 mr-1">Q{i + 1}.</span>
                          {q.question || q.key || q.id}
                          {q.required && (
                            <span className="text-red-500 ml-1">*</span>
                          )}
                        </th>
                        <td className="px-3 py-2 text-slate-800 whitespace-pre-wrap">
                          {formatAnswerForDisplay(
                            response.responses?.[q.id],
                            q
                          ) || <span className="text-slate-400 italic">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <footer className="px-6 py-3 border-t border-slate-200 bg-slate-50 rounded-b-xl flex items-center justify-between gap-2">
          <button
            onClick={onDelete}
            className="text-xs font-semibold text-red-700 hover:bg-red-50 px-3 py-1.5 rounded-md flex items-center gap-1.5"
          >
            <Trash2 size={13} /> Delete
          </button>
          <div className="flex items-center gap-2">
            {response.status !== 'reviewed' && (
              <button
                onClick={onMarkReviewed}
                className="text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-md flex items-center gap-1.5"
              >
                <CheckCircle2 size={13} /> Mark Reviewed
              </button>
            )}
            <button
              onClick={onClose}
              className="text-xs font-semibold bg-slate-700 hover:bg-slate-800 text-white px-3 py-1.5 rounded-md"
            >
              Close
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
};

const MetaTile: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
}> = ({ icon, label, value }) => (
  <div className="border border-slate-200 rounded-lg px-3 py-2">
    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
      {icon} {label}
    </div>
    <div className="text-sm font-medium text-slate-800 mt-0.5 break-words">
      {value}
    </div>
  </div>
);

const StatusPillIcon: React.FC<{
  status: QuestionnaireResponse['status'];
}> = ({ status }) =>
  status === 'reviewed' ? (
    <CheckCircle2 size={14} className="text-emerald-500" />
  ) : status === 'submitted' ? (
    <FileText size={14} className="text-blue-500" />
  ) : (
    <Clock size={14} className="text-slate-400" />
  );

// ---------------------------------------------------------------------------
// Local helpers (display-time stringification)
// ---------------------------------------------------------------------------

const ensureOpts = (opts: Question['options']) => {
  if (!opts || opts.length === 0) return [];
  if (typeof opts[0] === 'string') {
    return (opts as string[]).map((s, i) => ({ id: `opt_${i}`, value: s, label: s }));
  }
  return opts as { id: string; value: string; label: string }[];
};

/** 24h "HH:MM" → 12h "H:MM AM/PM". Returns input unchanged if unparseable. */
const toAmPm = (hhmm: string): string => {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return hhmm;
  let h = parseInt(m[1], 10);
  if (!Number.isFinite(h) || h < 0 || h > 23) return hhmm;
  const mm = m[2];
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${mm} ${ampm}`;
};

const formatAnswerForDisplay = (v: unknown, q?: Question): string => {
  if (v == null) return '';
  if (Array.isArray(v)) {
    if (q) {
      const opts = ensureOpts(q.options);
      if (opts.length > 0) {
        return v
          .map((x) => opts.find((o) => o.value === x)?.label ?? String(x))
          .join(', ');
      }
    }
    return v.map((x) => String(x)).join(', ');
  }
  if (typeof v === 'object') {
    try {
      return Object.entries(v as Record<string, unknown>)
        .map(([k, val]) => `${k}: ${String(val ?? '')}`)
        .join('\n');
    } catch {
      return String(v);
    }
  }
  if (q?.type === 'time' && typeof v === 'string') {
    return toAmPm(v);
  }
  if (q?.type === 'datetime' && typeof v === 'string') {
    const m = v.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{1,2}:\d{2}(?::\d{2})?)$/);
    if (m) return `${m[1]} ${toAmPm(m[2])}`;
  }
  if (q) {
    const opts = ensureOpts(q.options);
    const match = opts.find((o) => o.value === v);
    if (match) return match.label;
  }
  return String(v);
};
