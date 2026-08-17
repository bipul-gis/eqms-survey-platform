import React, { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, CircleMarker, Popup, GeoJSON, useMap } from 'react-leaflet';
import L from 'leaflet';
import { geosurveyApi } from '../lib/geosurveyApi';
import {
  formatChoiceAnswerForExport,
  isOtherSpecifyAnswer
} from '../lib/choiceAnswers';
import { formatPhotoAnswerLabel } from '../lib/photoAnswers';
import { Question, Questionnaire, QuestionnaireResponse, UserProfile } from '../types';
import { assignedSlumsForProject, formatAssignedSlumLabels } from '../lib/assignedSlums';
import { assignedZoneValuesFromProfile, zonesToGeoJson } from '../lib/assignedZones';
import { zoneLayersApi } from '../lib/zoneLayersApi';
import { DEFAULT_PROJECT_ID } from '../lib/projects';
import { useAuth } from './AuthProvider';
import { Map as MapIcon, ChevronDown, ChevronUp } from 'lucide-react';
import type { SurveyLocationMarker } from './MapComponent';
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
  buildResponsesShpFieldMappingCsv,
  buildResponsesTable,
  createResponsesExportAccumulator,
  downloadResponsesCsvFromTable,
  fmtDate,
  tsToDate
} from '../lib/responseExport';
// Lazy-load SHP export (jszip + shp-write) — only when the button is clicked.
const loadDownloadResponsesShpZip = () =>
  import('../lib/responseShpExport').then((m) => m.downloadResponsesShpZipFromBundle);
import 'leaflet/dist/leaflet.css';

interface QuestionnaireResponsesViewProps {
  questionnaire: Questionnaire;
  onClose: () => void;
}

type StatusFilter = 'all' | 'draft' | 'submitted' | 'queued' | 'reviewed';

/** Above this many responses, a photo export gets a "this is slow" warning. */
const LARGE_PHOTO_EXPORT_THRESHOLD = 300;

export const QuestionnaireResponsesView: React.FC<QuestionnaireResponsesViewProps> = ({
  questionnaire: initialQuestionnaire,
  onClose
}) => {
  const { user, userProfile } = useAuth();
  const isAdmin = userProfile?.role === 'admin' && userProfile?.status === 'approved';
  /** Live questionnaire definition — columns in CSV preview/export follow this. */
  const [questionnaire, setQuestionnaire] = useState<Questionnaire>(initialQuestionnaire);
  const [responses, setResponses] = useState<QuestionnaireResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<QuestionnaireResponse | null>(null);
  const [showDeleteAll, setShowDeleteAll] = useState(false);
  const [deleteAllConfirmText, setDeleteAllConfirmText] = useState('');
  const [deletingAll, setDeletingAll] = useState(false);
  const [exportingShp, setExportingShp] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [includePhotos, setIncludePhotos] = useState(true);
  const [exportProgress, setExportProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [deleteAllProgress, setDeleteAllProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  const projectId = questionnaire.projectId ?? DEFAULT_PROJECT_ID;
  /** Imported boundary SHP for this project — same layer as Geospatial Assignment. */
  const [zoneBoundaries, setZoneBoundaries] = useState<GeoJSON.FeatureCollection | null>(null);
  const [zoneAssignField, setZoneAssignField] = useState<string | null>(null);
  const [questionnaireTitleById, setQuestionnaireTitleById] = useState<Record<string, string>>({});
  const [taskedEnumerators, setTaskedEnumerators] = useState<
    {
      key: string;
      name: string;
      email?: string;
      slumIds: string[];
      zoneValues: string[];
      questionnaireIds: string[];
    }[]
  >([]);

  const fetchResponses = async () => {
    try {
      setLoading(true);
      setFetchError(null);
      // Slim list strips embedded photo dataUrls (~20MB → ~0.1MB for this project).
      // Full payloads are fetched only when exporting CSV/SHP.
      const [responsesResult, usersResult, titlesResult] = await Promise.all([
        geosurveyApi.listResponses({ questionnaireId: questionnaire.id, slim: true }),
        geosurveyApi.listUsers(),
        geosurveyApi.listQuestionnaires(projectId),
      ]);

      const list: QuestionnaireResponse[] = [];
      for (const item of responsesResult.items) list.push(item as unknown as QuestionnaireResponse);
      list.sort((a, b) => {
        const ta = tsToDate(a.submittedAt)?.getTime() ?? 0;
        const tb = tsToDate(b.submittedAt)?.getTime() ?? 0;
        return tb - ta;
      });
      setResponses(list);

      // Prefer the live definition from the project questionnaire list when present.
      const liveQuestionnaire = (titlesResult.items as unknown as Questionnaire[]).find(
        (q) => q.id === questionnaire.id
      );
      if (liveQuestionnaire) {
        setQuestionnaire(liveQuestionnaire);
      }

      const titleMap: Record<string, string> = {};
      for (const item of titlesResult.items as unknown as Questionnaire[]) {
        titleMap[item.id] = (item.title || '').trim() || item.id;
      }
      setQuestionnaireTitleById(titleMap);

      const byEmail = new Map<
        string,
        {
          key: string;
          name: string;
          email?: string;
          slumIds: string[];
          zoneValues: string[];
          questionnaireIds: string[];
        }
      >();
      for (const data of usersResult.items as UserProfile[]) {
        if (data.role !== 'enumerator') continue;
        const qids = data.assignedQuestionnaireIds || [];
        if (!qids.includes(questionnaire.id)) continue;
        const email = (data.email || '').trim();
        const emailKey = email.toLowerCase();
        if (!emailKey) continue;
        const slumIds = assignedSlumsForProject(data, projectId);
        const zoneValues = assignedZoneValuesFromProfile(data, projectId);
        const questionnaireIds = [
          ...new Set((qids || []).map((id) => String(id).trim()).filter(Boolean))
        ].sort();
        const existing = byEmail.get(emailKey);
        if (!existing) {
          byEmail.set(emailKey, {
            key: emailKey,
            name: (data.displayName || '').trim() || email,
            email: email || undefined,
            slumIds,
            zoneValues,
            questionnaireIds
          });
        } else {
          existing.slumIds = [...new Set([...existing.slumIds, ...slumIds])].sort();
          existing.zoneValues = [...new Set([...existing.zoneValues, ...zoneValues])].sort((a, b) =>
            a.localeCompare(b)
          );
          existing.questionnaireIds = [
            ...new Set([...existing.questionnaireIds, ...questionnaireIds])
          ].sort();
        }
      }
      setTaskedEnumerators(
        Array.from(byEmail.values()).sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      );
    } catch (error) {
      console.error('Error fetching responses:', error);
      setFetchError(
        error instanceof Error ? error.message : 'Failed to load responses.'
      );
    } finally {
      setLoading(false);
    }
  };

  /**
   * Stream full payloads (with photos) for the given ids, one page per
   * request. Pages are handed to the caller and then dropped, so a survey with
   * thousands of photo-bearing responses never sits in memory all at once.
   */
  const streamFullResponsesForExport = async (
    ids: string[],
    onPage: (page: QuestionnaireResponse[]) => void
  ): Promise<void> => {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    const pageSize = 50;
    setExportProgress({ done: 0, total: uniqueIds.length });
    for (let i = 0; i < uniqueIds.length; i += pageSize) {
      const pageIds = uniqueIds.slice(i, i + pageSize);
      const { items } = await geosurveyApi.getResponsesBatch(pageIds);
      const byId = new Map(
        (items as unknown as QuestionnaireResponse[]).map((item) => [item.id, item])
      );
      onPage(pageIds.map((id) => byId.get(id)).filter(Boolean) as QuestionnaireResponse[]);
      setExportProgress({
        done: Math.min(i + pageSize, uniqueIds.length),
        total: uniqueIds.length
      });
      // Yield to the browser so the progress label repaints between pages.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  /** Rows for the current filter: streamed full payloads, or the slim list. */
  const buildExportBundle = async () => {
    const accumulator = createResponsesExportAccumulator(questionnaire, filtered, {
      attachPhotos: includePhotos
    });
    if (includePhotos) {
      await streamFullResponsesForExport(
        filtered.map((r) => r.id),
        (page) => accumulator.addPage(page)
      );
    } else {
      accumulator.addPage(filtered);
    }
    return accumulator.result();
  };

  useEffect(() => {
    setQuestionnaire(initialQuestionnaire);
  }, [initialQuestionnaire]);

  useEffect(() => {
    const handleQueueChanged = () => void fetchResponses();
    window.addEventListener('geosurvey:offline-queue-changed', handleQueueChanged);
    return () => {
      window.removeEventListener('geosurvey:offline-queue-changed', handleQueueChanged);
    };
  }, [questionnaire.id]);

  useEffect(() => {
    void fetchResponses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionnaire.id]);

  // Imported boundary SHP for the preview map (same source as Geospatial Assignment).
  useEffect(() => {
    let cancelled = false;
    const loadZones = async () => {
      if (!projectId) {
        setZoneBoundaries(null);
        setZoneAssignField(null);
        return;
      }
      try {
        const { items, polygons } = await zoneLayersApi.listLayersWithPolygons(projectId);
        if (cancelled) return;
        const layer = items[0];
        if (!layer || !polygons?.length) {
          setZoneBoundaries(null);
          setZoneAssignField(null);
          return;
        }
        setZoneAssignField(layer.labelField || layer.assignmentField || 'Zone');
        setZoneBoundaries(
          zonesToGeoJson(polygons, {
            labelField: layer.labelField || layer.assignmentField || null,
          })
        );
      } catch (error) {
        console.warn('Could not load zone boundaries for responses map', error);
        if (!cancelled) {
          setZoneBoundaries(null);
          setZoneAssignField(null);
        }
      }
    };
    void loadZones();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // GPS points for the responses map — submission GPS first, then any
  // location-question answers stored on the response.
  const surveyLocationMarkers = useMemo<SurveyLocationMarker[]>(() => {
    const out: SurveyLocationMarker[] = [];
    const locationQuestionIds = new Set(
      (questionnaire.questions || [])
        .filter((q) => q.type === 'location')
        .map((q) => q.id)
    );

    const pushPoint = (
      r: QuestionnaireResponse,
      lat: number,
      lng: number,
      accuracy?: number,
      capturedAt?: unknown
    ) => {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
      out.push({
        id: `${r.id}:${out.length}`,
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
    };

    for (const r of responses) {
      const sub = (r as { submissionLocation?: { lat?: number; lng?: number; accuracy?: number; capturedAt?: unknown } })
        .submissionLocation;
      if (
        sub &&
        typeof sub.lat === 'number' &&
        typeof sub.lng === 'number' &&
        Number.isFinite(sub.lat) &&
        Number.isFinite(sub.lng)
      ) {
        pushPoint(
          r,
          sub.lat,
          sub.lng,
          typeof sub.accuracy === 'number' ? sub.accuracy : undefined,
          sub.capturedAt
        );
        continue;
      }

      const loc = r.location;
      if (
        loc &&
        typeof loc.lat === 'number' &&
        typeof loc.lng === 'number' &&
        Number.isFinite(loc.lat) &&
        Number.isFinite(loc.lng)
      ) {
        pushPoint(r, loc.lat, loc.lng);
        continue;
      }

      // Fall back to answers on location-type questions.
      if (r.responses) {
        for (const [qid, raw] of Object.entries(r.responses)) {
          if (locationQuestionIds.size > 0 && !locationQuestionIds.has(qid)) continue;
          if (!raw || typeof raw !== 'object') continue;
          const ans = raw as { lat?: unknown; lng?: unknown; accuracy?: unknown };
          if (typeof ans.lat !== 'number' || typeof ans.lng !== 'number') continue;
          pushPoint(
            r,
            ans.lat,
            ans.lng,
            typeof ans.accuracy === 'number' ? ans.accuracy : undefined
          );
          break;
        }
      }
    }
    return out;
  }, [responses, questionnaire.title, questionnaire.questions]);

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
    const c = { all: responses.length, draft: 0, submitted: 0, queued: 0, reviewed: 0 };
    for (const r of responses) {
      if (r.status === 'draft') c.draft++;
      else if (r.status === 'queued') c.queued++;
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

  const formatQuestionnaireLabels = (ids: string[]): string => {
    const unique = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
    if (unique.length === 0) return '—';
    return unique
      .map((id) => {
        if (id === questionnaire.id) {
          return questionnaire.title?.trim() || 'This survey';
        }
        return questionnaireTitleById[id] || id;
      })
      .join(', ');
  };

  /** Merges task area assignments (zones or slums) with per-response activity counts. */
  const hasZoneAssignments = useMemo(
    () =>
      Boolean(zoneBoundaries?.features?.length) ||
      taskedEnumerators.some((a) => a.zoneValues.length > 0),
    [zoneBoundaries, taskedEnumerators]
  );
  const hasSlumAssignments = useMemo(
    () => taskedEnumerators.some((a) => a.slumIds.length > 0),
    [taskedEnumerators]
  );
  /** Prefer zone boundaries when the project has an imported SHP; fall back to slums. */
  const areaScope: 'zone' | 'slum' | 'none' = hasZoneAssignments
    ? 'zone'
    : hasSlumAssignments
      ? 'slum'
      : zoneBoundaries
        ? 'zone'
        : 'none';
  const areaColumnLabel =
    areaScope === 'zone'
      ? zoneAssignField
        ? `Zone · ${zoneAssignField}`
        : 'Zone(s)'
      : areaScope === 'slum'
        ? 'Slum(s)'
        : 'Area';

  const enumeratorSummary = useMemo(() => {
    const map = new Map<string, EnumeratorBreakdownEntry>();

    const formatAreaLabels = (a: {
      slumIds: string[];
      zoneValues: string[];
    }): string => {
      if (areaScope === 'zone') {
        return a.zoneValues.length ? a.zoneValues.join(', ') : '—';
      }
      if (areaScope === 'slum') {
        return formatAssignedSlumLabels(a.slumIds);
      }
      // Neither configured — show whichever the enumerator actually has.
      if (a.zoneValues.length) return a.zoneValues.join(', ');
      if (a.slumIds.length) return formatAssignedSlumLabels(a.slumIds);
      return '—';
    };

    for (const a of taskedEnumerators) {
      map.set(a.key, {
        uid: a.key,
        name: a.name,
        email: a.email,
        areaLabels: formatAreaLabels(a),
        questionnaireLabels: formatQuestionnaireLabels(a.questionnaireIds),
        draft: 0,
        submitted: 0,
        reviewed: 0,
        total: 0,
        lastSeen: 0
      });
    }

    for (const e of enumeratorBreakdown) {
      const keys = [
        e.email?.trim().toLowerCase(),
        e.uid
      ].filter((k): k is string => !!k);
      let row = keys.map((k) => map.get(k)).find(Boolean);
      if (!row) {
        row = {
          uid: e.uid,
          name: e.name,
          email: e.email,
          areaLabels: '—',
          questionnaireLabels: '—',
          draft: 0,
          submitted: 0,
          reviewed: 0,
          total: 0,
          lastSeen: 0
        };
        for (const k of keys) map.set(k, row);
      }
      row.draft = e.draft;
      row.submitted = e.submitted;
      row.reviewed = e.reviewed;
      row.total = e.total;
      row.lastSeen = e.lastSeen;
      if ((row.name === 'Unknown' || !row.name) && e.name) row.name = e.name;
      if (!row.email && e.email) row.email = e.email;
    }

    const seen = new Set<EnumeratorBreakdownEntry>();
    const out: EnumeratorBreakdownEntry[] = [];
    for (const row of map.values()) {
      if (seen.has(row)) continue;
      seen.add(row);
      out.push(row);
    }

    return out.sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      return (a.name || '').localeCompare(b.name || '');
    });
  }, [
    taskedEnumerators,
    enumeratorBreakdown,
    questionnaire.id,
    questionnaire.title,
    questionnaireTitleById,
    areaScope,
  ]);

  const markReviewed = async (r: QuestionnaireResponse) => {
    if (!user) return;
    try {
      await geosurveyApi.saveResponse({
        ...r,
        status: 'reviewed',
        reviewedAt: new Date().toISOString(),
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
      alert(error instanceof Error ? error.message : 'Failed to mark response reviewed');
    }
  };

  const handleDelete = async (r: QuestionnaireResponse) => {
    if (!confirm('Delete this response? This cannot be undone.')) return;
    try {
      await geosurveyApi.deleteResponse(r.id);
      setResponses((prev) => prev.filter((x) => x.id !== r.id));
      if (selected?.id === r.id) setSelected(null);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to delete response');
    }
  };

  /**
   * Bulk-delete every response that's currently loaded for this
   * questionnaire. We rely on the local `responses` snapshot (already scoped
   * to `questionnaireId`) as the source of truth so the delete cannot
   * accidentally span other questionnaires. Firestore caps a single
   * `writeBatch` at 500 ops, so we chunk and commit sequentially. Progress
   * is surfaced to the user via the modal in case the dataset is large.
   */
  const handleDeleteAll = async () => {
    if (!isAdmin) return;
    if (responses.length === 0) return;
    setDeletingAll(true);
    setDeleteAllProgress({ done: 0, total: responses.length });
    try {
      const ids = responses.map((r) => r.id);
      let done = 0;
      for (const id of ids) {
        await geosurveyApi.deleteResponse(id);
        done += 1;
        setDeleteAllProgress({ done, total: ids.length });
      }
      setResponses([]);
      setSelected(null);
      setShowDeleteAll(false);
      setDeleteAllConfirmText('');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to delete all responses');
    } finally {
      setDeletingAll(false);
      setDeleteAllProgress(null);
    }
  };

  /**
   * Photo payloads are ~100× the size of the answers, so warn before pulling
   * thousands of them into the browser.
   */
  const confirmLargePhotoExport = (): boolean => {
    if (!includePhotos || filtered.length <= LARGE_PHOTO_EXPORT_THRESHOLD) return true;
    return confirm(
      `${filtered.length} responses with photos can take several minutes to download.\n\n` +
        'OK to continue, or Cancel and untick "Include photos" for a fast data-only export.'
    );
  };

  const handleExportCsv = async () => {
    if (filtered.length === 0) {
      alert('Nothing to export — no responses match the current filter.');
      return;
    }
    if (!confirmLargePhotoExport()) return;
    setExportingCsv(true);
    try {
      const bundle = await buildExportBundle();
      const { photoCount } = await downloadResponsesCsvFromTable(questionnaire, bundle);
      alert(
        photoCount > 0
          ? `CSV ZIP ready with ${photoCount} photo file(s) under photos/{survey-type}/. Names: enumeratorId_enumeratorName_responseId_serial.`
          : 'CSV ZIP ready (no photo files in this export).'
      );
    } catch (error) {
      console.error('CSV export failed', error);
      const message = error instanceof Error ? error.message : String(error);
      alert(`Failed to export CSV: ${message}`);
    } finally {
      setExportingCsv(false);
      setExportProgress(null);
    }
  };

  const handleExportShp = async () => {
    if (filtered.length === 0) {
      alert('Nothing to export — no responses match the current filter.');
      return;
    }
    if (!confirmLargePhotoExport()) return;
    setExportingShp(true);
    try {
      const downloadShp = await loadDownloadResponsesShpZip();
      const bundle = await buildExportBundle();
      const { exported, skippedNoGps, photoCount } = await downloadShp(
        questionnaire,
        bundle,
        buildResponsesShpFieldMappingCsv(questionnaire, filtered)
      );
      const photoNote =
        photoCount > 0
          ? ` Includes ${photoCount} photo(s) in photos/.`
          : '';
      const mappingNote =
        ' Open *_field_mapping.csv inside the ZIP for CSV column → SHP DBF name lookup.';
      if (skippedNoGps > 0) {
        alert(
          `SHP ZIP ready: ${exported} point(s) exported. Skipped ${skippedNoGps} response(s) with no GPS coordinates.${photoNote}${mappingNote}`
        );
      } else {
        alert(`SHP ZIP ready: ${exported} point(s).${photoNote}${mappingNote}`);
      }
    } catch (error) {
      console.error('SHP export failed', error);
      const message = error instanceof Error ? error.message : String(error);
      alert(`Failed to export shapefile: ${message}`);
    } finally {
      setExportingShp(false);
      setExportProgress(null);
    }
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
        {isAdmin && (
          <button
            onClick={() => {
              setDeleteAllConfirmText('');
              setShowDeleteAll(true);
            }}
            disabled={loading || responses.length === 0 || deletingAll}
            className="px-3 py-2 text-sm font-semibold bg-rose-600 hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg flex items-center gap-1.5 transition-colors"
            title="Permanently delete every response for this questionnaire"
          >
            <Trash2 size={15} /> Delete All ({responses.length})
          </button>
        )}
        <div className="flex items-center gap-2">
          <label
            className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 select-none"
            title="Photos are large. Untick for a fast, data-only export."
          >
            <input
              type="checkbox"
              checked={includePhotos}
              onChange={(e) => setIncludePhotos(e.target.checked)}
              disabled={exportingCsv || exportingShp}
              className="accent-emerald-600"
            />
            Include photos
          </label>
          <button
            onClick={() => void handleExportCsv()}
            disabled={loading || exportingCsv || exportingShp || filtered.length === 0}
            className="px-3 py-2 text-sm font-semibold bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg flex items-center gap-1.5 transition-colors"
            title="Download matching responses as a ZIP (CSV + photos/ folder with attached images)"
          >
            <FileSpreadsheet size={15} />{' '}
            {exportingCsv
              ? exportProgress
                ? `Exporting CSV… ${exportProgress.done}/${exportProgress.total}`
                : 'Exporting CSV…'
              : `Export CSV (${filtered.length})`}
          </button>
          <button
            onClick={() => void handleExportShp()}
            disabled={loading || exportingCsv || exportingShp || filtered.length === 0}
            className="px-3 py-2 text-sm font-semibold bg-sky-600 hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg flex items-center gap-1.5 transition-colors"
            title="Download zipped shapefile (WGS84) with photos/ attached. Includes field_mapping.csv for CSV column → DBF name lookup."
          >
            <MapIcon size={15} />{' '}
            {exportingShp
              ? exportProgress
                ? `Exporting SHP… ${exportProgress.done}/${exportProgress.total}`
                : 'Exporting SHP…'
              : `Export SHP ZIP (${filtered.length})`}
          </button>
        </div>
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
        ) : (
        // Two-column layout on xl+: main column flexes to fill all
        // remaining horizontal space (no `max-w-*` cap) so the sidebar
        // gets pushed flush against the right edge of the viewport
        // instead of leaving dead whitespace there. The response table
        // and CSV preview inside scroll horizontally as needed, so
        // dropping the cap doesn't visually distort them. Below xl
        // the columns stack vertically.
        <div className="flex flex-col xl:flex-row gap-6">
          <div className="flex-1 min-w-0 flex flex-col gap-6">
          {responses.length === 0 ? (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm px-6 py-14 text-center text-slate-500">
              <FileText size={48} className="mx-auto mb-4 text-slate-300" />
              <p className="font-medium text-slate-700">No responses yet for this questionnaire</p>
              <p className="text-sm mt-1 max-w-md mx-auto">
                Responses will appear here as enumerators submit them. Task assignments (
                {areaScope === 'zone'
                  ? 'zones and questionnaires'
                  : areaScope === 'slum'
                    ? 'slums and questionnaires'
                    : 'area and questionnaires'}{' '}
                per enumerator) are shown in the panel on the right.
              </p>
            </div>
          ) : (
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
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
                    ['queued', 'Queued', counts.queued],
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
              <CsvPreview
                questionnaire={questionnaire}
                responses={filtered}
                onView={(r) => setSelected(r)}
                onDelete={(r) => void handleDelete(r)}
              />
            )}
          </div>
          )}
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
            <EnumeratorBreakdownPanel
              enumerators={enumeratorSummary}
              assignedCount={taskedEnumerators.length}
              areaColumnLabel={areaColumnLabel}
              areaScope={areaScope}
            />
            {/* Imported boundary SHP + captured GPS points (no CCC landmarks). */}
            {(responses.length > 0 || zoneBoundaries) && (
              <ResponsesMapPanel
                surveyLocations={surveyLocationMarkers}
                zoneBoundaries={zoneBoundaries}
              />
            )}
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

      {/* Bulk delete confirmation. Admin-only; requires the user to type
          "DELETE" so a stray click can't wipe out the dataset. */}
      {showDeleteAll && (
        <div
          className="fixed inset-0 z-[1015] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => {
            if (!deletingAll) {
              setShowDeleteAll(false);
              setDeleteAllConfirmText('');
            }
          }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 border border-slate-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-rose-100 flex items-center justify-center shrink-0">
                <AlertCircle size={20} className="text-rose-600" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-bold text-slate-900">
                  Delete all responses?
                </h3>
                <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">
                  This will permanently remove all{' '}
                  <span className="font-bold text-slate-700">{responses.length}</span>{' '}
                  responses (drafts + submitted + reviewed) for{' '}
                  <span className="font-semibold text-slate-700">
                    {questionnaire.title}
                  </span>
                  . This action cannot be undone.
                </p>
              </div>
            </div>

            <div className="mb-4">
              <label className="block text-[11px] font-semibold text-slate-600 uppercase tracking-wider mb-1.5">
                Type <span className="text-rose-600 font-bold">DELETE</span> to
                confirm
              </label>
              <input
                type="text"
                value={deleteAllConfirmText}
                onChange={(e) => setDeleteAllConfirmText(e.target.value)}
                disabled={deletingAll}
                placeholder="DELETE"
                autoFocus
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:ring-2 focus:ring-rose-500 focus:border-rose-500 outline-none disabled:opacity-60"
              />
            </div>

            {deleteAllProgress && (
              <div className="mb-4 text-xs text-slate-600">
                <div className="flex justify-between mb-1">
                  <span>Deleting…</span>
                  <span className="font-semibold">
                    {deleteAllProgress.done} / {deleteAllProgress.total}
                  </span>
                </div>
                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-rose-500 transition-all"
                    style={{
                      width: `${
                        (deleteAllProgress.done /
                          Math.max(1, deleteAllProgress.total)) *
                        100
                      }%`
                    }}
                  />
                </div>
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  if (!deletingAll) {
                    setShowDeleteAll(false);
                    setDeleteAllConfirmText('');
                  }
                }}
                disabled={deletingAll}
                className="px-3 py-2 text-sm font-semibold rounded-lg text-slate-700 hover:bg-slate-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteAll()}
                disabled={
                  deletingAll || deleteAllConfirmText.trim().toUpperCase() !== 'DELETE'
                }
                className="px-3 py-2 text-sm font-semibold rounded-lg bg-rose-600 hover:bg-rose-700 text-white disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
              >
                <Trash2 size={14} />
                {deletingAll ? 'Deleting…' : `Delete ${responses.length}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// ResponsesMapPanel — satellite map of the project's imported boundary SHP
// (same layer and imagery as Geospatial Assignment) plus captured GPS points.
// No CCC wards / landmarks. Fits bounds to the boundaries and points together.
// ---------------------------------------------------------------------------
const MAP_VISIBLE_STORAGE_KEY = 'eqms_responses_map_visible_v1';
/** White ring keeps the pins readable against satellite imagery. */
const SURVEY_LOCATION_RING = '#ffffff';
const SURVEY_LOCATION_COLOR_BY_STATUS: Record<string, string> = {
  draft: '#9ca3af',
  submitted: '#111827',
  reviewed: '#16a34a'
};
const BANGLADESH_FALLBACK: [number, number] = [23.685, 90.3563];

function formatSurveyTimestamp(value: unknown): string {
  if (!value) return '—';
  try {
    if (typeof value === 'object' && value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
      return (value as { toDate: () => Date }).toDate().toLocaleString();
    }
    if (typeof value === 'string' || typeof value === 'number') {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return d.toLocaleString();
    }
  } catch {
    /* fall through */
  }
  return '—';
}

/**
 * Fit / re-fit the map to the imported boundary SHP plus captured GPS points,
 * so the zone polygons are always in view alongside the responses.
 */
const FitGpsBounds: React.FC<{
  points: SurveyLocationMarker[];
  zoneBoundaries?: GeoJSON.FeatureCollection | null;
}> = ({ points, zoneBoundaries }) => {
  const map = useMap();
  useEffect(() => {
    const bounds = L.latLngBounds([]);
    if (zoneBoundaries?.features?.length) {
      try {
        const zoneBounds = L.geoJSON(zoneBoundaries).getBounds();
        if (zoneBounds.isValid()) bounds.extend(zoneBounds);
      } catch {
        /* ignore malformed geometry */
      }
    }
    for (const p of points) bounds.extend([p.lat, p.lng] as [number, number]);

    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [36, 36], maxZoom: 17 });
      return;
    }
    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lng], 16);
      return;
    }
    map.setView(BANGLADESH_FALLBACK, 7);
  }, [map, points, zoneBoundaries]);
  return null;
};

const ZONE_BOUNDARY_STYLE: L.PathOptions = {
  color: '#0284c7',
  weight: 2,
  fillColor: '#0ea5e9',
  fillOpacity: 0.08,
};

const ZONE_BOUNDARY_HOVER_STYLE: L.PathOptions = {
  color: '#38bdf8',
  weight: 4,
  fillColor: '#7dd3fc',
  fillOpacity: 0.22,
};

const ResponsesMapPanel: React.FC<{
  surveyLocations: SurveyLocationMarker[];
  zoneBoundaries?: GeoJSON.FeatureCollection | null;
}> = ({ surveyLocations, zoneBoundaries }) => {
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
      /* localStorage may be blocked */
    }
  }, [visible]);

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
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col h-[500px]">
      <div className="px-3 py-2 border-b border-slate-200 flex items-center gap-2 shrink-0">
        <MapIcon size={14} className="text-blue-600 shrink-0" />
        <h3 className="font-semibold text-slate-800 text-xs">Geospatial preview</h3>
        {surveyLocations.length > 0 ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-slate-700 bg-slate-100 border border-slate-300 rounded-full px-1.5 py-0.5">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: '#374151' }}
              aria-hidden
            />
            {surveyLocations.length} GPS
          </span>
        ) : (
          <span className="text-[10px] text-slate-500">No GPS points in these responses</span>
        )}
        {zoneBoundaries?.features?.length ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-sky-700 bg-sky-50 border border-sky-200 rounded-full px-1.5 py-0.5">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: ZONE_BOUNDARY_STYLE.color }}
              aria-hidden
            />
            {zoneBoundaries.features.length} zones
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setVisible(false)}
          className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded px-1.5 py-1 transition-colors"
          title="Hide geospatial preview"
        >
          Hide <ChevronUp size={12} />
        </button>
      </div>
      <div className="relative w-full flex-1 min-h-0">
        <MapContainer
          center={BANGLADESH_FALLBACK}
          zoom={7}
          className="absolute inset-0 h-full w-full z-0"
          scrollWheelZoom
        >
          <TileLayer
            attribution="Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics"
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            maxNativeZoom={19}
            maxZoom={22}
          />
          <FitGpsBounds points={surveyLocations} zoneBoundaries={zoneBoundaries} />
          {/* Imported boundary SHP — drawn under the GPS pins. */}
          {zoneBoundaries?.features?.length ? (
            <GeoJSON
              key={`zones:${zoneBoundaries.features.length}`}
              data={zoneBoundaries}
              style={() => ZONE_BOUNDARY_STYLE}
              onEachFeature={(feature, layer) => {
                const label = (feature?.properties as { __label?: string } | undefined)?.__label;
                if (label) {
                  layer.bindTooltip(String(label), {
                    permanent: true,
                    direction: 'center',
                    className: 'zone-label',
                    opacity: 1,
                  });
                }
                // Highlight the polygon outline on hover — not a white click rectangle.
                layer.on({
                  mouseover: (e) => {
                    const target = e.target as L.Path;
                    target.setStyle(ZONE_BOUNDARY_HOVER_STYLE);
                    if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) {
                      target.bringToFront();
                    }
                  },
                  mouseout: (e) => {
                    (e.target as L.Path).setStyle(ZONE_BOUNDARY_STYLE);
                  },
                  click: (e) => {
                    // Keep map click-to-pan/zoom; suppress default path selection UI.
                    L.DomEvent.stopPropagation(e);
                  },
                });
              }}
            />
          ) : null}
          {surveyLocations.map((point) => {
            const status = point.status ?? 'submitted';
            const fill =
              SURVEY_LOCATION_COLOR_BY_STATUS[status] ||
              SURVEY_LOCATION_COLOR_BY_STATUS.submitted;
            const tsLabel = formatSurveyTimestamp(point.submittedAt || point.capturedAt);
            return (
              <CircleMarker
                key={point.id}
                center={[point.lat, point.lng]}
                radius={7}
                pathOptions={{
                  color: SURVEY_LOCATION_RING,
                  fillColor: fill,
                  fillOpacity: 0.95,
                  weight: 2
                }}
              >
                <Popup>
                  <div className="min-w-[200px] text-[11px]">
                    <p className="font-semibold text-slate-900 text-sm mb-1">
                      {point.respondentName || 'Unknown enumerator'}
                    </p>
                    {point.respondentEmail ? (
                      <p className="text-slate-500 mb-2">{point.respondentEmail}</p>
                    ) : null}
                    <p>
                      <span className="text-slate-500">Status:</span>{' '}
                      <span className="capitalize">{status}</span>
                    </p>
                    <p className="font-mono">
                      {point.lat.toFixed(6)}, {point.lng.toFixed(6)}
                    </p>
                    {typeof point.accuracy === 'number' ? (
                      <p>±{Math.round(point.accuracy)} m</p>
                    ) : null}
                    <p className="text-slate-500 mt-1">{tsLabel}</p>
                  </div>
                </Popup>
              </CircleMarker>
            );
          })}
        </MapContainer>
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
  /** Zone values or slum labels — chosen dynamically from project assignment type. */
  areaLabels: string;
  questionnaireLabels: string;
  draft: number;
  submitted: number;
  reviewed: number;
  total: number;
  lastSeen: number;
}

const EnumeratorBreakdownPanel: React.FC<{
  enumerators: EnumeratorBreakdownEntry[];
  assignedCount: number;
  areaColumnLabel: string;
  areaScope: 'zone' | 'slum' | 'none';
}> = ({ enumerators, assignedCount, areaColumnLabel, areaScope }) => {
  const totalResponses = enumerators.reduce((s, e) => s + e.total, 0);
  const emptyHint =
    areaScope === 'zone'
      ? 'No enumerators assigned to this questionnaire yet. Assign boundaries and questionnaires in User Management.'
      : areaScope === 'slum'
        ? 'No enumerators assigned to this questionnaire yet. Assign slums and questionnaires in User Management → Tasks.'
        : 'No enumerators assigned to this questionnaire yet. Assign tasks in User Management.';

  return (
    // Compact card — same visual rhythm as the Geospatial Survey's "By
    // enumerator" QC summary so admins recognise the format across both
    // tabs. Header on top, single dense table below with one row per
    // enumerator showing per-status counts (D/S/R) + total.
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden xl:sticky xl:top-0 p-3 h-[250px] flex flex-col">
      <div className="flex items-center gap-1.5 mb-1.5 shrink-0">
        <Users size={14} className="text-slate-600 shrink-0" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600">
          Task assignments & responses
        </span>
        <span className="ml-auto text-[10px] text-slate-400 tabular-nums text-right leading-tight">
          {assignedCount} assigned
          <br />
          {totalResponses} resp.
        </span>
      </div>

      {enumerators.length === 0 ? (
        <p className="text-[10px] text-slate-400 italic px-1 py-2">{emptyHint}</p>
      ) : (
        <div className="qc-panel-scroll flex-1 min-h-0 overflow-y-auto rounded-lg border border-slate-100">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="bg-slate-50 text-slate-500">
                <th className="text-left px-1.5 py-1 font-semibold">Name</th>
                <th
                  className="text-left px-1 py-1 font-semibold min-w-[4rem]"
                  title={areaColumnLabel}
                >
                  {areaScope === 'zone' ? 'Zone(s)' : areaScope === 'slum' ? 'Slum(s)' : 'Area'}
                </th>
                <th className="text-left px-1 py-1 font-semibold min-w-[4rem]">Survey(s)</th>
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
                  <td className="px-1.5 py-1 text-slate-800 truncate max-w-[7rem]">
                    {e.name || <span className="text-slate-400 italic">Unknown</span>}
                  </td>
                  <td
                    className="px-1 py-1 text-slate-600 truncate max-w-[7rem] text-[9px] leading-snug"
                    title={e.areaLabels !== '—' ? e.areaLabels : undefined}
                  >
                    {e.areaLabels}
                  </td>
                  <td
                    className="px-1 py-1 text-slate-600 truncate max-w-[7rem] text-[9px] leading-snug"
                    title={e.questionnaireLabels !== '—' ? e.questionnaireLabels : undefined}
                  >
                    {e.questionnaireLabels}
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
// Uses the same `buildResponsesTable` helper as the downloader. Shows every
// filtered response with column sort and row-level View / Delete actions.
// ---------------------------------------------------------------------------

const CSV_PREVIEW_ROW_H = 'h-8';
const CSV_PREVIEW_CELL =
  'h-8 max-h-8 px-2 py-0 align-middle overflow-hidden whitespace-nowrap leading-none box-border';
/** Sticky leading columns (actions + row #) stay visible when scrolling horizontally. */
const CSV_PREVIEW_STICKY_ACTIONS =
  'sticky left-0 z-30 bg-inherit border-r border-slate-200 shadow-[2px_0_4px_-2px_rgba(15,23,42,0.12)]';
const CSV_PREVIEW_STICKY_NUM =
  'sticky left-[3.25rem] z-20 bg-inherit border-r border-slate-200 shadow-[2px_0_4px_-2px_rgba(15,23,42,0.08)]';

/** Compare two CSV preview cells; blanks sort last on ascending order. */
function compareCsvPreviewCells(a: string, b: string): number {
  const sa = (a ?? '').trim();
  const sb = (b ?? '').trim();
  if (!sa && !sb) return 0;
  if (!sa) return 1;
  if (!sb) return -1;
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' });
}

type CsvPreviewRow = { row: string[]; response: QuestionnaireResponse };

const CsvPreview: React.FC<{
  questionnaire: Questionnaire;
  responses: QuestionnaireResponse[];
  onView: (r: QuestionnaireResponse) => void;
  onDelete: (r: QuestionnaireResponse) => void;
}> = ({ questionnaire, responses, onView, onDelete }) => {
  const questionColumnKey = useMemo(() => {
    const qs = questionnaire.questions || [];
    return qs
      .map(
        (q) =>
          `${q.id}\t${q.type}\t${q.parentId || ''}\t${q.question || q.key || ''}\t${(q.rows || []).join('\t')}`
      )
      .join('\n');
  }, [questionnaire.questions]);
  const enumeratorColumnKey = useMemo(
    () =>
      (questionnaire.enumeratorInfo?.fields || [])
        .map((f) => `${f.id}\t${f.question || f.key || ''}`)
        .join('\n'),
    [questionnaire.enumeratorInfo?.fields]
  );
  const { header, tableRows } = useMemo(() => {
    const built = buildResponsesTable(questionnaire, responses);
    const tableRows: CsvPreviewRow[] = built.rows.map((row, i) => ({
      row,
      response: responses[i]
    }));
    return { header: built.header, tableRows };
  }, [questionnaire, responses, questionColumnKey, enumeratorColumnKey]);

  const [sort, setSort] = useState<{ col: number; dir: 'asc' | 'desc' } | null>(null);

  const sortedTableRows = useMemo(() => {
    if (sort == null) return tableRows;
    const { col, dir } = sort;
    const mult = dir === 'asc' ? 1 : -1;
    return [...tableRows].sort((a, b) => {
      const ca = col < a.row.length ? a.row[col] ?? '' : '';
      const cb = col < b.row.length ? b.row[col] ?? '' : '';
      return mult * compareCsvPreviewCells(ca, cb);
    });
  }, [tableRows, sort]);

  if (tableRows.length === 0) return null;

  return (
    <>
      <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/40">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-slate-800 flex items-center gap-1.5">
            <FileSpreadsheet size={15} className="text-emerald-600" />
            CSV export preview
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Exact layout of the downloaded file.{' '}
            <span className="font-bold text-slate-700">{tableRows.length}</span> response
            {tableRows.length === 1 ? '' : 's'}
            {' · '}
            {header.length} column{header.length === 1 ? '' : 's'}
            {' · '}
            <span className="text-slate-600">Click a column title to sort (all columns move together).</span>
          </p>
        </div>
      </div>

      <div className="qc-panel-scroll h-[615px] overflow-auto border-b border-slate-100">
        <table className="w-max min-w-full text-[11px] border-collapse">
          <thead className="bg-slate-50 sticky top-0 z-40 shadow-[0_1px_0_0_rgba(15,23,42,0.08)]">
            <tr className={CSV_PREVIEW_ROW_H}>
              <th
                scope="col"
                className={`${CSV_PREVIEW_CELL} ${CSV_PREVIEW_STICKY_ACTIONS} text-[9px] font-bold text-slate-400 uppercase tracking-wider text-center bg-slate-50`}
              >
                Actions
              </th>
              <th
                scope="col"
                className={`${CSV_PREVIEW_CELL} ${CSV_PREVIEW_STICKY_NUM} text-[9px] font-bold text-slate-400 uppercase tracking-wider text-right bg-slate-50 cursor-pointer hover:bg-slate-100 select-none`}
                title="Reset sort — restore original row order"
                onClick={() => setSort(null)}
              >
                #
              </th>
              {header.map((h, i) => {
                const active = sort?.col === i;
                return (
                  <th
                    key={i}
                    scope="col"
                    title={`Sort by ${h}`}
                    onClick={() =>
                      setSort((prev) =>
                        prev?.col === i
                          ? { col: i, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
                          : { col: i, dir: 'asc' }
                      )
                    }
                    aria-sort={
                      active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined
                    }
                    className={`${CSV_PREVIEW_CELL} text-[9px] font-bold text-slate-500 uppercase tracking-wider border-r border-slate-100 last:border-r-0 bg-slate-50 cursor-pointer hover:bg-slate-100 select-none text-left`}
                  >
                    <span className="inline-flex items-center gap-0.5 max-w-[12rem]">
                      <span className="truncate" title={h}>
                        {h}
                      </span>
                      {active &&
                        (sort!.dir === 'asc' ? (
                          <ChevronUp size={12} className="shrink-0 text-slate-500" aria-hidden />
                        ) : (
                          <ChevronDown size={12} className="shrink-0 text-slate-500" aria-hidden />
                        ))}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedTableRows.map(({ row, response }, ri) => (
              <tr
                key={response.id}
                className={`${CSV_PREVIEW_ROW_H} border-b border-slate-100 even:bg-slate-50/40 hover:bg-blue-50/40 transition-colors`}
              >
                <td className={`${CSV_PREVIEW_CELL} ${CSV_PREVIEW_STICKY_ACTIONS} bg-white even:bg-slate-50/40`}>
                  <div className="flex h-8 items-center justify-center gap-1">
                    <button
                      type="button"
                      onClick={() => onView(response)}
                      className="p-0.5 text-blue-700 hover:bg-blue-50 rounded inline-flex items-center justify-center"
                      title="View response"
                    >
                      <Eye size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(response)}
                      className="p-0.5 text-red-700 hover:bg-red-50 rounded inline-flex items-center justify-center"
                      title="Delete"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </td>
                <td
                  className={`${CSV_PREVIEW_CELL} ${CSV_PREVIEW_STICKY_NUM} text-slate-400 text-right font-mono tabular-nums bg-white even:bg-slate-50/40`}
                >
                  {ri + 1}
                </td>
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className={`${CSV_PREVIEW_CELL} text-slate-700 border-r border-slate-100 last:border-r-0 font-mono`}
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

      <div className="px-4 py-2 text-[11px] text-slate-500 border-t border-slate-200 bg-slate-50/40">
        View/Delete are the first columns (stay pinned on the left when you scroll horizontally). Use the
        scrollbars to move through all rows and columns.
      </div>
    </>
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
              {fmtDate(response.submittedAt) || 'unsubmitted'}
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
              icon={<FileText size={14} className="text-slate-500" />}
              label="Submission ID"
              value={response.id}
            />
            <MetaTile
              icon={<StatusPillIcon status={response.status} />}
              label="Status"
              value={response.status}
            />
            {questionnaire.consentGate?.enabled ? (
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
            ) : null}
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
                value={`${response.submissionLocation.lat.toFixed(6)}, ${response.submissionLocation.lng.toFixed(6)} (±${response.submissionLocation.accuracy.toFixed(1)} m)${
                  response.submissionLocation.capturedAt
                    ? ` · ${fmtDate(response.submissionLocation.capturedAt)}`
                    : ''
                }`}
              />
            )}
            {(response.submittedAt || response.status === 'submitted') && (
              <MetaTile
                icon={<Clock size={14} className="text-slate-500" />}
                label="Submitted At"
                value={fmtDate(response.submittedAt) || '—'}
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
                          {q.type === 'responseId' && (
                            <span className="ml-1.5 text-[9px] font-bold uppercase tracking-wider text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1 py-0.5">
                              Auto Serial
                            </span>
                          )}
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
  ) : status === 'queued' ? (
    <Clock size={14} className="text-amber-500" />
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

/**
 * Render an `age` answer object as a human-readable string. Pluralises
 * "year"/"years" and "month"/"months" and drops a zero segment when the
 * other one is non-zero ("3 years" instead of "3 years 0 months"), but
 * keeps "0 months" when the whole age is zero so the cell never appears
 * blank for a filled response.
 */
const formatAgeAnswer = (v: unknown): string => {
  if (!v || typeof v !== 'object') return '';
  const obj = v as { years?: number | string; months?: number | string };
  const y = Number(obj.years ?? 0);
  const m = Number(obj.months ?? 0);
  if (!Number.isFinite(y) && !Number.isFinite(m)) return '';
  const yy = Number.isFinite(y) ? y : 0;
  const mm = Number.isFinite(m) ? m : 0;
  if (yy === 0 && mm === 0) return '0 months';
  const parts: string[] = [];
  if (yy > 0) parts.push(`${yy} ${yy === 1 ? 'year' : 'years'}`);
  if (mm > 0) parts.push(`${mm} ${mm === 1 ? 'month' : 'months'}`);
  return parts.join(' ');
};

const formatAnswerForDisplay = (v: unknown, q?: Question): string => {
  if (v == null) return '';
  if (q?.type === 'photo') {
    return formatPhotoAnswerLabel(v);
  }
  if (isOtherSpecifyAnswer(v)) {
    return formatChoiceAnswerForExport(v);
  }
  // `age` answers are stored as { years, months, totalMonths } — render
  // them as the natural "3 years 5 months" string the admins expect to
  // see in the response detail panel and CSV preview.
  if (q?.type === 'age' && typeof v === 'object' && !Array.isArray(v)) {
    return formatAgeAnswer(v);
  }
  // `computed` answers are stored as the raw number/string the formula
  // produced, but admins authored the prefix/suffix on the builder side
  // (e.g. "BDT " / " m²") — re-apply them here so the review screen and
  // CSV preview line up with what enumerators saw on the device.
  if (q?.type === 'computed') {
    const prefix = q.computed?.prefix ?? '';
    const suffix = q.computed?.suffix ?? '';
    if (v === '' || v === null || v === undefined) return '';
    return `${prefix}${String(v)}${suffix}`;
  }
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
    // Slim / legacy photo payloads — never dump base64 or stub metadata.
    const photoObj = v as { dataUrl?: unknown; hasPhoto?: boolean; _photo?: boolean };
    if (
      photoObj.hasPhoto === true ||
      photoObj._photo === true ||
      (typeof photoObj.dataUrl === 'string' &&
        String(photoObj.dataUrl).startsWith('data:image'))
    ) {
      return formatPhotoAnswerLabel(v);
    }
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
