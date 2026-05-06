import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthProvider, useAuth } from './components/AuthProvider';
import { GeoLocationProvider, useGeoLocation } from './components/GeoLocationProvider';
import { MapComponent } from './components/MapComponent';
import { FeatureEditor } from './components/FeatureEditor';
import { LoginScreen } from './components/LoginScreen';
import { UserManagement } from './components/UserManagement';
import { QuestionnaireManager } from './components/QuestionnaireManager';
import { QuestionnaireForm } from './components/QuestionnaireForm';
import { useOptimizedFeatures, type FeaturesLoadMode } from './hooks/useOptimizedFeatures';
import { FeatureStatus, GeoFeature, Questionnaire, UserProfile } from './types';
import {
  MapPin,
  Map as MapIcon,
  List,
  LogOut,
  Shield,
  Compass,
  Activity,
  CheckCircle2,
  UserPlus,
  FileText,
  Database,
  Clock,
  AlertCircle,
  Users,
  RefreshCw
} from 'lucide-react';
import {
  collection,
  addDoc,
  setDoc,
  serverTimestamp,
  writeBatch,
  doc,
  query,
  where,
  getDocs,
  limit,
  startAfter,
  orderBy,
  documentId,
  onSnapshot,
  updateDoc
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './lib/firebase';
import wardsData from './data/ccc_wards.json';
import { fetchLandmarkGeoJson } from './lib/landmarkGeoJson';
import shpwrite from '@mapbox/shp-write';
import {
  assignedWardsFromUserProfile,
  featureMatchesAssignedWardsResolved,
  isTrivialWardValue,
  normalizeWardKey,
  parseWardNumber,
  TASK_WARD_ATTR,
  taskScopeWardLabel,
  wardLabelFromAttributes,
  wardMatchesAssignedList,
  withBaselineTaskWard
} from './lib/wardGeometry';
import { isSlumCategory, SLUM_DEMOGRAPHIC_KEY_SET } from './lib/slumFeatureFields';
import { NEW_POINT_ADD_PROXIMITY_METERS } from './lib/newPointProximity';
import { isLandmarkPointFormComplete, landmarkHasEnumeratorActivity } from './lib/landmarkQcCompleteness';
import { formatChangeAtReadable } from './lib/formatChangeAt';
import { patchShapefileZipUtf8Dbf } from './lib/dbfUtf8';

const isImportedLandmarkPoint = (f: GeoFeature) => {
  if (f.type !== 'point') return false;
  const src = String(f.attributes?.__source || '');
  return src === 'ccc_landmark' || src === 'ccc_landmark_geojson' || src === 'ccc_landmark_import';
};

const isNewlyAddedFeature = (f: GeoFeature) =>
  typeof f.newFeatureRemarks === 'string' && f.newFeatureRemarks.trim().length > 0;

/** Landmark points counted in enumerator Quality Control (includes manual map adds, not only GeoJSON imports). */
const isEnumeratorScopeLandmarkPoint = (f: GeoFeature) => {
  if (f.type !== 'point') return false;
  const src = String(f.attributes?.__source || '');
  return (
    src === 'ccc_landmark' ||
    src === 'ccc_landmark_geojson' ||
    src === 'ccc_landmark_import' ||
    src === 'landmark_manual'
  );
};

const FEATURE_STATUS_SET = new Set<FeatureStatus>(['pending', 'verified', 'rejected']);

const getFeatureStatusFromQc = (f: GeoFeature): FeatureStatus => {
  const attrs = (f.attributes || {}) as Record<string, unknown>;
  const normalizedKeyMap = new Map<string, unknown>();
  for (const [k, v] of Object.entries(attrs)) {
    const nk = k.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (nk) normalizedKeyMap.set(nk, v);
  }

  const rawQcStatus =
    attrs.QC_Status ??
    attrs.qc_status ??
    attrs.qcStatus ??
    attrs.ChangeStatus ??
    normalizedKeyMap.get('qcstatus') ??
    normalizedKeyMap.get('changestatus');

  const normalizedStatus = String(rawQcStatus ?? '').trim().toLowerCase();
  if (FEATURE_STATUS_SET.has(normalizedStatus as FeatureStatus)) {
    return normalizedStatus as FeatureStatus;
  }
  return f.status;
};

const LANDMARK_TABLE_ATTRIBUTE_ORDER = ['FID', 'Category', 'Type', 'Ownership', 'Ward_Name', 'Zone'] as const;

const landmarkAttributesForTable = (attrs: Record<string, any>) => {
  const normalized: Record<string, any> = {
    FID: attrs?.FID ?? '',
    Category: attrs?.Category ?? '',
    Type: attrs?.Type ?? '',
    Ownership: attrs?.Ownership ?? '',
    Ward_Name: attrs?.Ward_Name ?? attrs?.WARDNAME ?? attrs?.WardName ?? '',
    Zone: attrs?.Zone ?? ''
  };

  const ordered = LANDMARK_TABLE_ATTRIBUTE_ORDER
    .map((k) => [k, normalized[k]] as [string, any])
    .filter(([, v]) => String(v ?? '').trim() !== '');

  // Table list should follow landmark JSON schema only (no extra/custom keys).
  return ordered.slice(0, 2);
};

/** DBF (shapefile) only records string/number/boolean; normalize Firestore values. */
const toShpPrimitive = (v: unknown): string | number | boolean => {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as { toDate?: () => Date; seconds?: number; nanoseconds?: number };
    if (typeof o.toDate === 'function') {
      try {
        return o.toDate().toISOString();
      } catch {
        return '';
      }
    }
    if (typeof o.seconds === 'number') {
      return new Date(o.seconds * 1000).toISOString();
    }
    return JSON.stringify(v);
  }
  return String(v);
};

/** GeoJSON/Firestore-safe value for imported landmark properties (full replace + merge upload). */
const normalizeImportedPropertyValue = (v: unknown): unknown => {
  if (v === null) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v === undefined) return undefined;
  if (typeof v === 'object') {
    const o = v as { toDate?: () => Date; seconds?: number };
    if (typeof o.toDate === 'function') {
      try {
        return o.toDate().toISOString();
      } catch {
        return '';
      }
    }
    if (typeof o.seconds === 'number') {
      return new Date(o.seconds * 1000).toISOString();
    }
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
};

/** Keep slum-only fields only when Category is slum. */
const sanitizeSlumOnlyFields = (attrs: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...attrs };
  if (!isSlumCategory(out as Record<string, any>)) {
    for (const k of SLUM_DEMOGRAPHIC_KEY_SET) {
      delete out[k];
    }
  }
  return out;
};

/**
 * All columns from uploaded GeoJSON, normalized for Firestore (aligned with SHP attribute handling).
 * Strips app-internal keys from the file; optional FID override from normalized landmark id.
 */
const normalizeImportedLandmarkProperties = (
  raw: Record<string, unknown> | null | undefined,
  fidOverride?: number
): Record<string, unknown> => {
  const src = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
  delete src.__source;
  delete src.__taskWard;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k.startsWith('__')) continue;
    if (v === undefined) continue;
    const n = normalizeImportedPropertyValue(v);
    if (n !== undefined) out[k] = n;
  }
  if (fidOverride !== undefined) {
    out.FID = fidOverride;
  }
  return sanitizeSlumOnlyFields(out);
};

const parsePointCoordinates = (coords: unknown): [number, number] => {
  const a = Array.isArray(coords) ? coords : [0, 0];
  const lng = typeof a[0] === 'number' ? a[0] : Number(a[0]);
  const lat = typeof a[1] === 'number' ? a[1] : Number(a[1]);
  return [
    Number.isFinite(lng) ? lng : 0,
    Number.isFinite(lat) ? lat : 0
  ];
};

/** Approved enumerators with ward assignment — used for SHP `UpdatedBy` (task ward → enumerator email). */
type ShpEnumeratorAssignee = { email: string; assignedWardNames: string[] };

function assignedEnumeratorEmailForLandmark(
  feature: GeoFeature,
  enumerators: ShpEnumeratorAssignee[] | undefined
): string {
  if (!enumerators?.length) return '';
  const wardLabel = taskScopeWardLabel(feature, wardsData);
  if (!wardLabel) return '';
  for (const e of enumerators) {
    if (
      e.assignedWardNames.length > 0 &&
      wardMatchesAssignedList(wardLabel, e.assignedWardNames)
    ) {
      return e.email;
    }
  }
  return '';
}

/** Omit from generic attribute copy — folded into `ChangedAt` or omitted from SHP entirely. */
const SHP_ATTR_OMIT = new Set(['ChangeBy', 'ChangeAt']);

/**
 * Shapefile row properties: landmark attributes (no `__*` keys).
 * - **TaskWard**: immutable assigned ward (`__taskWard` only). Enumerator edits to `Ward_Name` do not change TaskWard.
 * - **Ward_Name** / etc.: from attributes (includes enumerator corrections).
 * - **ChangedAt**: single QC/edit timestamp (verification → attribute edit → last save).
 */
const landmarkShpRowProperties = (
  feature: GeoFeature,
  enumeratorAssignees?: ShpEnumeratorAssignee[]
): Record<string, string | number | boolean> => {
  const attrs = sanitizeSlumOnlyFields((feature.attributes || {}) as Record<string, unknown>) as Record<string, any>;
  const out: Record<string, string | number | boolean> = {};

  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('__')) continue;
    if (SHP_ATTR_OMIT.has(k)) continue;
    out[k] = toShpPrimitive(v);
  }

  const fieldChangeAt = formatChangeAtReadable(attrs.ChangeAt).trim();
  const qcVerifiedAt = formatChangeAtReadable(feature.verifiedAt).trim();
  const updatedByFromWard = assignedEnumeratorEmailForLandmark(feature, enumeratorAssignees).trim();

  const tw = attrs[TASK_WARD_ATTR];
  out.TaskWard =
    tw != null && !isTrivialWardValue(tw) ? String(toShpPrimitive(tw)).trim() : '';

  const changedAtOnly =
    qcVerifiedAt || fieldChangeAt || formatChangeAtReadable(feature.updatedAt).trim();

  return {
    ...out,
    ChangeStatus: feature.status,
    QC_Status: feature.status,
    ChangeRemarks: String(feature.remarks ?? ''),
    RejectRmrks: String(feature.remarks ?? ''),
    MoveRemarks: String(feature.moveRemarks ?? ''),
    NewFeatureRemarks: String(feature.newFeatureRemarks ?? ''),
    UpdatedBy: updatedByFromWard,
    ChangedAt: changedAtOnly,
    GPS_Lat: feature.collectorLocation?.lat ?? '',
    GPS_Lng: feature.collectorLocation?.lng ?? '',
    GPS_Acc: feature.collectorLocation?.accuracy ?? ''
  };
};

const mapLandmarkFeaturesToShpGeoJsonFeatures = (
  featureList: GeoFeature[],
  enumeratorAssignees?: ShpEnumeratorAssignee[]
) => {
  const toNumber = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return featureList
    .map((feature) => {
      const coords = Array.isArray(feature.geometry?.coordinates) ? feature.geometry.coordinates : [];
      const lng = toNumber(coords[0]);
      const lat = toNumber(coords[1]);
      if (lng === null || lat === null) return null;
      return {
        type: 'Feature' as const,
        id: feature.attributes?.FID ?? feature.id,
        geometry: { type: 'Point' as const, coordinates: [lng, lat] },
        properties: landmarkShpRowProperties(feature, enumeratorAssignees)
      };
    })
    .filter(Boolean);
};

/** Table search: substring match, or every whitespace token present (handles "ward 4" vs stored "4"). */
const haystackMatchesTableQuery = (haystack: string, q: string): boolean => {
  const trimmed = q.trim().toLowerCase();
  if (!trimmed) return true;
  const h = haystack.toLowerCase();
  if (h.includes(trimmed)) return true;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return false;
  return tokens.every((t) => h.includes(t));
};

const toTitleCaseWords = (input: string): string =>
  input
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');

const normalizedFullName = (displayName: string | undefined, email: string): string => {
  const raw = String(displayName || '').trim();
  const emailLocal = email.split('@')[0] || '';
  const rawKey = raw.toLowerCase();
  const emailKey = email.toLowerCase();
  const localKey = emailLocal.toLowerCase();
  const looksLikeEmailOrUsername =
    !raw ||
    rawKey === emailKey ||
    rawKey === localKey ||
    /^[a-z0-9._-]+$/i.test(raw);

  if (looksLikeEmailOrUsername) {
    const pretty = emailLocal.replace(/[._-]+/g, ' ').trim();
    return toTitleCaseWords(pretty || raw || email);
  }
  return toTitleCaseWords(raw);
};

const AppContent: React.FC = () => {
  const { user, userProfile, loading: authLoading, logout } = useAuth();
  const { location, error: gpsError, requestLocation } = useGeoLocation();

  const [selectedFeature, setSelectedFeature] = useState<GeoFeature | null>(null);
  const [featureFocusRequestKey, setFeatureFocusRequestKey] = useState(0);
  const [isAddingFeature, setIsAddingFeature] = useState<'point' | 'line' | 'polygon' | null>(null);
  const [showUserManagement, setShowUserManagement] = useState(false);
  const [showQuestionnaireManager, setShowQuestionnaireManager] = useState(false);
  const [selectedQuestionnaire, setSelectedQuestionnaire] = useState<Questionnaire | null>(null);
  const [questionnaireLocation, setQuestionnaireLocation] = useState<{ lat: number; lng: number; ward?: string } | null>(null);
  const [activeTab, setActiveTab] = useState<'map' | 'list'>('map');
  const [movingFeature, setMovingFeature] = useState<GeoFeature | null>(null);
  const movingFeatureRef = useRef<GeoFeature | null>(null);
  useEffect(() => {
    movingFeatureRef.current = movingFeature;
  }, [movingFeature]);
  const [lastMovedPoint, setLastMovedPoint] = useState<{
    featureId: string;
    featureName: string;
    previousGeometry: any;
  } | null>(null);
  const [enumeratorQcExpanded, setEnumeratorQcExpanded] = useState(true);
  const [expandedWardKeys, setExpandedWardKeys] = useState<string[]>([]);
  const [isImportingLandmarks, setIsImportingLandmarks] = useState(false);
  const [importProgress, setImportProgress] = useState<{
    total: number;
    processed: number;
    written: number;
    previousRemoved: number;
  } | null>(null);
  const [importNotice, setImportNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [landmarkWardOptions, setLandmarkWardOptions] = useState<string[]>([]);
  const [landmarkCategoryOptions, setLandmarkCategoryOptions] = useState<string[]>([]);
  const [selfMergedAssignedWards, setSelfMergedAssignedWards] = useState<string[]>([]);
  const [tableSearchQuery, setTableSearchQuery] = useState('');
  const uploadMergeInputRef = useRef<HTMLInputElement | null>(null);
  const [adminFeaturesRefreshKey, setAdminFeaturesRefreshKey] = useState(0);
  const [enumeratorFeaturesRefreshKey, setEnumeratorFeaturesRefreshKey] = useState(0);
  const backPressArmedUntilRef = useRef(0);
  const [showBackExitWarning, setShowBackExitWarning] = useState(false);
  const backWarningTimerRef = useRef<number | null>(null);
  const allowNextPopToLeaveRef = useRef(false);

  const isAdmin = userProfile?.role === 'admin' && userProfile?.status === 'approved';
  const isApprovedEnumerator = userProfile?.role === 'enumerator' && userProfile?.status === 'approved';

  useEffect(() => {
    if (
      isAdmin ||
      userProfile?.role !== 'enumerator' ||
      userProfile?.status !== 'approved' ||
      !userProfile?.email
    ) {
      setSelfMergedAssignedWards([]);
      return;
    }

    const myEmailKey = userProfile.email.trim().toLowerCase();
    const q = query(collection(db, 'users'), where('status', '==', 'approved'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const merged = new Set<string>();
        snap.forEach((docSnap) => {
          const d = docSnap.data() as UserProfile;
          if (d.role !== 'enumerator') return;
          if ((d.email || '').trim().toLowerCase() !== myEmailKey) return;
          for (const w of assignedWardsFromUserProfile(d)) {
            const v = String(w).trim();
            if (v) merged.add(v);
          }
        });
        setSelfMergedAssignedWards([...merged]);
      },
      () => {
        setSelfMergedAssignedWards([]);
      }
    );
    return () => unsub();
  }, [isAdmin, userProfile?.role, userProfile?.status, userProfile?.email]);

  useEffect(() => {
    const isLikelyMobile =
      /Android|iPhone|iPad|iPod|Mobile|Opera Mini|IEMobile/i.test(navigator.userAgent) ||
      window.innerWidth <= 900;
    const shouldGuardBack = isApprovedEnumerator && isLikelyMobile;
    if (!shouldGuardBack) return;

    // Keep one synthetic history entry so first browser-back is consumed inside app.
    const pushGuardState = () =>
      window.history.pushState(
        { ...(window.history.state || {}), __guardBack: true },
        document.title,
        window.location.href
      );
    pushGuardState();

    const onPopState = () => {
      if (allowNextPopToLeaveRef.current) {
        allowNextPopToLeaveRef.current = false;
        return;
      }

      const now = Date.now();
      if (now <= backPressArmedUntilRef.current) {
        // Second back press within window: allow the browser to leave.
        backPressArmedUntilRef.current = 0;
        if (backWarningTimerRef.current !== null) {
          window.clearTimeout(backWarningTimerRef.current);
          backWarningTimerRef.current = null;
        }
        setShowBackExitWarning(false);
        allowNextPopToLeaveRef.current = true;
        window.history.back();
        return;
      }

      // First back press: show warning and remain in app by re-pushing guard state.
      backPressArmedUntilRef.current = now + 4000;
      setShowBackExitWarning(true);
      if (backWarningTimerRef.current !== null) {
        window.clearTimeout(backWarningTimerRef.current);
      }
      backWarningTimerRef.current = window.setTimeout(() => {
        setShowBackExitWarning(false);
        backWarningTimerRef.current = null;
      }, 4000);
      window.history.pushState({ ...(window.history.state || {}), __guardBack: true }, document.title, window.location.href);
    };

    const onPageShow = () => {
      // Re-entered tab/page (including BFCache restore): always re-arm guard cycle.
      allowNextPopToLeaveRef.current = false;
      backPressArmedUntilRef.current = 0;
      setShowBackExitWarning(false);
      pushGuardState();
    };

    window.addEventListener('popstate', onPopState);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('pageshow', onPageShow);
      if (backWarningTimerRef.current !== null) {
        window.clearTimeout(backWarningTimerRef.current);
        backWarningTimerRef.current = null;
      }
      setShowBackExitWarning(false);
      backPressArmedUntilRef.current = 0;
      allowNextPopToLeaveRef.current = false;
    };
  }, [isApprovedEnumerator]);

  const assignedWardsForFilter = useMemo(() => {
    if (isAdmin) return [] as string[];
    if (userProfile?.role !== 'enumerator' || userProfile?.status !== 'approved') return [] as string[];
    const list = selfMergedAssignedWards.length > 0 ? selfMergedAssignedWards : userProfile.assignedWardNames;
    if (Array.isArray(list) && list.length > 0) {
      return [...new Set(list.map((w) => String(w).trim()).filter(Boolean))];
    }
    const legacy = userProfile.assignedWardName;
    if (typeof legacy === 'string' && legacy.trim()) return [legacy.trim()];
    return [] as string[];
  }, [
    isAdmin,
    selfMergedAssignedWards,
    userProfile?.role,
    userProfile?.status,
    userProfile?.assignedWardNames,
    userProfile?.assignedWardName
  ]);

  const featuresMode = useMemo<FeaturesLoadMode>(() => {
    if (authLoading || !user) return 'idle';
    if (userProfile?.role === 'admin' && userProfile?.status === 'approved') return 'admin';
    if (userProfile?.role === 'enumerator' && userProfile?.status === 'approved') return 'enumerator';
    return 'idle';
  }, [authLoading, user, userProfile?.role, userProfile?.status]);

  const { features, loading: featuresLoading } = useOptimizedFeatures({
    mode: featuresMode,
    userUid: user?.uid,
    userEmail: user?.email ?? undefined,
    assignedWards: assignedWardsForFilter,
    adminRefreshKey: adminFeaturesRefreshKey,
    enumeratorPersistRefreshKey: enumeratorFeaturesRefreshKey
  });

  const visibleFeatures = useMemo(() => {
    if (isAdmin) return features;

    const myEmail = (user?.email || '').trim().toLowerCase();
    const myUid = user?.uid || '';
    const isCreatedByMe = (f: GeoFeature) => {
      const byEmail = String(f.createdBy || '').trim().toLowerCase();
      const byUid = String(f.createdByUid || '').trim();
      return (myEmail && byEmail === myEmail) || (myUid && byUid === myUid);
    };

    if (assignedWardsForFilter.length === 0) {
      return features.filter(isCreatedByMe);
    }

    // Strict task scope: only landmarks that resolve to an assigned ward (not "everything I created").
    return features.filter((f) =>
      featureMatchesAssignedWardsResolved(f, assignedWardsForFilter, wardsData)
    );
  }, [isAdmin, features, assignedWardsForFilter, wardsData, user?.email, user?.uid]);

  useEffect(() => {
    let mounted = true;

    const loadLandmarkReferenceOptions = async () => {
      try {
        const resp = await fetchLandmarkGeoJson();
        if (!resp.ok) return;
        const geo = await resp.json();
        const rows = Array.isArray(geo?.features) ? geo.features : [];
        const wards = rows
          .map((f: any) => f?.properties?.Ward_Name ?? f?.properties?.WARDNAME ?? f?.properties?.WardName)
          .map((v: unknown) => String(v ?? '').trim())
          .filter(Boolean);
        const categories = rows
          .map((f: any) => f?.properties?.Category ?? f?.properties?.category)
          .map((v: unknown) => String(v ?? '').trim())
          .filter(Boolean);
        if (!mounted) return;
        setLandmarkWardOptions([...new Set(wards)]);
        setLandmarkCategoryOptions([...new Set(categories)]);
      } catch {
        // Ignore reference-option load failures; editor still allows typed input.
      }
    };

    loadLandmarkReferenceOptions();
    return () => {
      mounted = false;
    };
  }, []);

  /** All ward labels from landmark GeoJSON, sorted ascending (numeric ward order when possible). */
  const wardOptionsForEditor = useMemo(() => {
    const unique = [...new Set(landmarkWardOptions.map((w) => String(w ?? '').trim()).filter(Boolean))];
    return unique.sort((a, b) => {
      const an = parseWardNumber(a);
      const bn = parseWardNumber(b);
      if (an !== null && bn !== null && an !== bn) return an - bn;
      if (an !== null && bn === null) return -1;
      if (an === null && bn !== null) return 1;
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });
  }, [landmarkWardOptions]);

  /** Distinct Category values from landmark GeoJSON (e.g. Slum), sorted A–Z. */
  const categoryOptionsForEditor = useMemo(() => {
    const unique = [...new Set(landmarkCategoryOptions.map((c) => String(c ?? '').trim()).filter(Boolean))];
    return unique.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [landmarkCategoryOptions]);

  /** Ward frozen for `attributes.__taskWard` on first save (does not change while the editor is open). */
  const editorTaskWardFreeze = useMemo(() => {
    if (!selectedFeature) return '' as string | number;
    const a = selectedFeature.attributes || {};
    if (a[TASK_WARD_ATTR] != null && !isTrivialWardValue(a[TASK_WARD_ATTR])) return a[TASK_WARD_ATTR];
    const wl = wardLabelFromAttributes(a);
    if (wl) return wl;
    return taskScopeWardLabel(selectedFeature, wardsData) || '';
  }, [selectedFeature]);

  /** Strict imported landmark rows (`ccc_landmark*` sources only — excludes manual map adds). */
  const importedLandmarkFeatures = useMemo(
    () => visibleFeatures.filter(isImportedLandmarkPoint),
    [visibleFeatures]
  );

  const enumeratorTaskStats = useMemo(() => {
    const lm = visibleFeatures.filter(isEnumeratorScopeLandmarkPoint);
    let verified = 0;
    let pending = 0;
    let rejected = 0;
    for (const f of lm) {
      const s = getFeatureStatusFromQc(f);
      if (s === 'verified') verified += 1;
      else if (s === 'rejected') rejected += 1;
      else pending += 1;
    }
    const newAdded = visibleFeatures.filter(isNewlyAddedFeature).length;
    return {
      verified,
      pending,
      rejected,
      newAdded,
      landmarkTotal: lm.length
    };
  }, [visibleFeatures]);

  const showEnumeratorQualityPanel =
    !isAdmin &&
    userProfile?.role === 'enumerator' &&
    userProfile?.status === 'approved' &&
    assignedWardsForFilter.length > 0;

  const [approvedEnumeratorsAdmin, setApprovedEnumeratorsAdmin] = useState<
    Array<{ email: string; displayName: string; assignedWardNames: string[] }>
  >([]);

  useEffect(() => {
    if (!isAdmin) {
      setApprovedEnumeratorsAdmin([]);
      return;
    }
    const q = query(collection(db, 'users'), where('status', '==', 'approved'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const byEmail = new Map<string, { email: string; displayName: string; assignedWardNames: string[] }>();
        snap.forEach((docSnap) => {
          const d = docSnap.data() as UserProfile;
          if (d.role !== 'enumerator') return;
          const email = (d.email || '').trim();
          if (!email) return;
          const key = email.toLowerCase();
          const wards = assignedWardsFromUserProfile(d);
          const candidateName = normalizedFullName(d.displayName, email);

          const existing = byEmail.get(key);
          if (!existing) {
            byEmail.set(key, {
              email,
              displayName: candidateName,
              assignedWardNames: wards
            });
            return;
          }

          // Prefer the most descriptive full-name variant.
          const existingScore = existing.displayName.replace(/\s+/g, '').length + (existing.displayName.includes(' ') ? 100 : 0);
          const candidateScore = candidateName.replace(/\s+/g, '').length + (candidateName.includes(' ') ? 100 : 0);
          if (candidateScore > existingScore) {
            existing.displayName = candidateName;
          }
          existing.assignedWardNames = [...new Set([...existing.assignedWardNames, ...wards])];
        });
        const rows = Array.from(byEmail.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
        setApprovedEnumeratorsAdmin(rows);
      },
      (err) => console.error('approved enumerators snapshot', err)
    );
    return () => unsub();
  }, [isAdmin]);

  type EnumeratorLandmarkSummaryRow = {
    email: string;
    displayName: string;
    pending: number;
    verified: number;
    rejected: number;
    newAdded: number;
    total: number;
  };

  const adminLandmarksByEnumerator = useMemo(() => {
    if (!isAdmin) {
      return { rows: [] as EnumeratorLandmarkSummaryRow[], unassigned: null as EnumeratorLandmarkSummaryRow | null };
    }

    const byEmail = new Map<string, EnumeratorLandmarkSummaryRow>();
    for (const e of approvedEnumeratorsAdmin) {
      const key = e.email.toLowerCase();
      byEmail.set(key, {
        email: e.email,
        displayName: e.displayName,
        pending: 0,
        verified: 0,
        rejected: 0,
        newAdded: 0,
        total: 0
      });
    }

    const unassigned: EnumeratorLandmarkSummaryRow = {
      email: '',
      displayName: 'Unassigned Landmark',
      pending: 0,
      verified: 0,
      rejected: 0,
      newAdded: 0,
      total: 0
    };

    for (const f of features) {
      // Enumerators table should include imported + manually added landmark points.
      if (!isEnumeratorScopeLandmarkPoint(f)) continue;
      const wardLabel = taskScopeWardLabel(f, wardsData);
      let matchKey: string | null = null;
      if (wardLabel) {
        for (const e of approvedEnumeratorsAdmin) {
          if (
            e.assignedWardNames.length > 0 &&
            wardMatchesAssignedList(wardLabel, e.assignedWardNames)
          ) {
            matchKey = e.email.toLowerCase();
            break;
          }
        }
      }
      const agg = matchKey ? byEmail.get(matchKey) : null;
      const t = agg ?? unassigned;
      t.total += 1;
      const s = getFeatureStatusFromQc(f);
      if (s === 'verified') t.verified += 1;
      else if (s === 'rejected') t.rejected += 1;
      else t.pending += 1;
      if (isNewlyAddedFeature(f)) t.newAdded += 1;
    }

    return {
      rows: Array.from(byEmail.values()),
      unassigned: unassigned.total > 0 ? unassigned : null
    };
  }, [isAdmin, features, approvedEnumeratorsAdmin]);

  const groupedWardRows = useMemo(() => {
    const byWard = new Map<string, GeoFeature[]>();
    for (const f of visibleFeatures) {
      const ward = taskScopeWardLabel(f, wardsData) || 'Unassigned';
      const arr = byWard.get(ward) ?? [];
      arr.push(f);
      byWard.set(ward, arr);
    }

    const rows = Array.from(byWard.entries()).map(([wardLabel, wardFeatures]) => ({
      wardLabel,
      wardKey: normalizeWardKey(wardLabel),
      features: wardFeatures.sort((a, b) => {
        const an = String(a.attributes?.name ?? a.attributes?.Name ?? '');
        const bn = String(b.attributes?.name ?? b.attributes?.Name ?? '');
        return an.localeCompare(bn);
      })
    }));

    rows.sort((a, b) => {
      const an = parseWardNumber(a.wardLabel);
      const bn = parseWardNumber(b.wardLabel);
      if (an !== null && bn !== null) return an - bn;
      if (an !== null) return -1;
      if (bn !== null) return 1;
      return a.wardLabel.localeCompare(b.wardLabel);
    });
    return rows;
  }, [visibleFeatures, wardsData]);

  const filteredGroupedWardRows = useMemo(() => {
    const q = tableSearchQuery.trim().toLowerCase();
    if (!q) return groupedWardRows;

    const matchesFeature = (f: GeoFeature) => {
      const attrs = f.attributes || {};
      const scopeWard = taskScopeWardLabel(f, wardsData);
      const scopeWardStr = scopeWard != null && !isTrivialWardValue(scopeWard) ? String(scopeWard).trim() : '';
      const scopeWardNum = scopeWardStr ? parseWardNumber(scopeWardStr) : null;
      const attrText = Object.entries(attrs)
        .filter(([k]) => !k.startsWith('__'))
        .map(([k, v]) => `${k} ${String(v ?? '')}`)
        .join(' ');
      const displayName = String(attrs.name ?? attrs.Name ?? '').trim();
      const text = [
        f.id,
        f.type,
        getFeatureStatusFromQc(f),
        displayName,
        String(attrs.FID ?? ''),
        String(attrs.Category ?? ''),
        String(attrs.Type ?? ''),
        String(attrs.Ownership ?? ''),
        String(attrs.Ward_Name ?? attrs.WARDNAME ?? attrs.WardName ?? ''),
        String(attrs.Zone ?? ''),
        scopeWardStr,
        scopeWardNum !== null ? `ward ${scopeWardNum}` : '',
        String(f.createdBy ?? ''),
        String(f.updatedBy ?? ''),
        attrText
      ].join(' ');
      return haystackMatchesTableQuery(text, q);
    };

    return groupedWardRows
      .map((row) => {
        const wardHit = haystackMatchesTableQuery(row.wardLabel, q);
        const nextFeatures = wardHit ? row.features : row.features.filter(matchesFeature);
        return { ...row, features: nextFeatures };
      })
      .filter((row) => row.features.length > 0);
  }, [groupedWardRows, tableSearchQuery, wardsData]);

  const tableListSearchExpandSig = useMemo(() => {
    const q = tableSearchQuery.trim();
    if (!q) return '';
    return filteredGroupedWardRows.map((r) => `${r.wardKey}:${r.features.length}`).join('|');
  }, [tableSearchQuery, filteredGroupedWardRows]);

  useEffect(() => {
    const q = tableSearchQuery.trim();
    if (!q) return;
    setExpandedWardKeys((prev) => {
      const next = new Set(prev);
      for (const row of filteredGroupedWardRows) {
        if (row.features.length > 0) next.add(row.wardKey);
      }
      return [...next];
    });
    // Expand from latest filtered rows when the query or filtered set changes; omit `filteredGroupedWardRows`
    // from deps so collapsing a ward while searching is not immediately undone on unrelated renders.
  }, [tableSearchQuery, tableListSearchExpandSig]);

  const wardOwnerByKey = useMemo(() => {
    const m = new Map<string, string>();
    if (!isAdmin) return m;
    for (const row of groupedWardRows) {
      const owners = approvedEnumeratorsAdmin
        .filter((e) => e.assignedWardNames.some((w) => wardMatchesAssignedList(row.wardLabel, [w])))
        .map((e) => e.displayName);
      const dedupedOwners = [...new Set(owners)];
      if (dedupedOwners.length > 0) m.set(row.wardKey, dedupedOwners.join(', '));
    }
    return m;
  }, [isAdmin, groupedWardRows, approvedEnumeratorsAdmin]);

  const toggleWardExpanded = (wardKey: string) => {
    setExpandedWardKeys((prev) =>
      prev.includes(wardKey) ? prev.filter((k) => k !== wardKey) : [...prev, wardKey]
    );
  };

  const distanceMeters = (lat1: number, lng1: number, lat2: number, lng2: number) => {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const R = 6371000; // earth radius meters
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  const normalizeLandmarkFid = (value: unknown): number | undefined => {
    if (value === null || value === undefined || value === '') return undefined;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const n = Number(String(value).trim());
    return Number.isFinite(n) ? n : undefined;
  };

  const fidsEqual = (a: unknown, b: unknown) => {
    if (a === b) return true;
    const na = normalizeLandmarkFid(a);
    const nb = normalizeLandmarkFid(b);
    if (na === undefined || nb === undefined) return false;
    return na === nb;
  };

  const importLandmarkGeoJson = async () => {
    if (!isAdmin || isImportingLandmarks) return;
    setIsImportingLandmarks(true);
    setImportNotice(null);
    try {
      // Use Vite asset URL so this works in production (e.g., Vercel) and local dev.
      const resp = await fetchLandmarkGeoJson();
      if (!resp.ok) {
        throw new Error(`GeoJSON fetch failed (${resp.status})`);
      }
      const geo = await resp.json();
      const points = Array.isArray(geo?.features)
        ? geo.features.filter((f: any) => f?.geometry?.type === 'Point')
        : [];

      if (points.length === 0) {
        setImportNotice({ type: 'error', message: 'No Point features found in CCC_all_Landmark.geojson.' });
        setImportProgress(null);
        setIsImportingLandmarks(false);
        return;
      }

      const confirmed = window.confirm(
        'This will DELETE ALL FEATURES currently stored in Firestore and replace them ONLY with this GeoJSON import.\n\n' +
          'Any non-import features (lines/polygons/manual points/etc.) will be permanently removed.\n\n' +
          'Continue?'
      );
      if (!confirmed) {
        setImportProgress(null);
        setIsImportingLandmarks(false);
        return;
      }

      const pointRecords = points.map((f: any, idx: number) => {
        const fid = normalizeLandmarkFid(f?.properties?.FID ?? f?.id ?? idx);
        const id = `landmark_${fid !== undefined ? fid : idx}`;
        return { id, fid, feature: f };
      });

      let writtenCount = 0;
      let removedCount = 0;
      const totalSteps = pointRecords.length;
      let processedCount = 0;
      setImportProgress({ total: totalSteps, processed: 0, written: 0, previousRemoved: 0 });

      const MAX_OPS = 450;

      // 1) Delete ALL documents in `features` (admin-only delete rule), then import only GeoJSON points.
      const pageSize = 450;

      let batch = writeBatch(db);
      let ops = 0;
      const commitIfNeeded = async (nextCost: number) => {
        if (ops + nextCost > MAX_OPS) {
          await batch.commit();
          batch = writeBatch(db);
          ops = 0;
        }
      };

      let cursor: any = null;
      while (true) {
        const base = query(collection(db, 'features'), orderBy(documentId()), limit(pageSize));
        const q = cursor ? query(base, startAfter(cursor)) : base;
        const snap = await getDocs(q);
        if (snap.empty) break;

        for (const d of snap.docs) {
          await commitIfNeeded(1);
          batch.delete(doc(db, 'features', d.id));
          ops += 1;
          removedCount += 1;
        }

        cursor = snap.docs[snap.docs.length - 1];
        if (snap.docs.length < pageSize) break;
      }

      if (ops > 0) {
        await batch.commit();
        batch = writeBatch(db);
        ops = 0;
      }
      // 2) Write fresh canonical landmark docs in large batches.
      const commitBatch = async () => {
        if (ops > 0) {
          await batch.commit();
          batch = writeBatch(db);
          ops = 0;
        }
      };

      let writeChunk = 0;
      for (const rec of pointRecords) {
        const ref = doc(db, 'features', rec.id);
        const [lng, lat] = parsePointCoordinates(rec.feature?.geometry?.coordinates);
        const rawProps =
          rec.feature?.properties != null && typeof rec.feature.properties === 'object'
            ? (rec.feature.properties as Record<string, unknown>)
            : {};
        const normalizedAttrs = normalizeImportedLandmarkProperties(rawProps, rec.fid);

        await commitIfNeeded(1);
        batch.set(ref, {
          type: 'point',
          geometry: { type: 'Point', coordinates: [lng, lat] },
          attributes: withBaselineTaskWard({
            ...normalizedAttrs,
            __source: 'ccc_landmark'
          }),
          status: 'pending',
          createdBy: 'ccc_landmark_import',
          updatedBy: user?.email || 'ccc_landmark_import',
          updatedByUid: user?.uid || null,
          updatedAt: serverTimestamp()
        });
        ops += 1;
        writtenCount += 1;
        writeChunk += 1;

        if (ops >= MAX_OPS) {
          await commitBatch();
        }
        // Avoid updating React state on every row for large imports.
        processedCount = writtenCount;
        if (writeChunk >= 100 || writtenCount === pointRecords.length) {
          setImportProgress({
            total: totalSteps,
            processed: processedCount,
            written: writtenCount,
            previousRemoved: removedCount
          });
          writeChunk = 0;
        }
      }
      await commitBatch();

      setImportProgress({
        total: totalSteps,
        processed: totalSteps,
        written: writtenCount,
        previousRemoved: removedCount
      });
      setImportNotice({
        type: 'success',
        message: `Import complete. Previous data removed: ${removedCount}. Landmarks written: ${writtenCount}.`
      });
      setAdminFeaturesRefreshKey((k) => k + 1);
    } catch (e) {
      console.error(e);
      setImportNotice({ type: 'error', message: 'Landmark GeoJSON import failed: ' + e });
    } finally {
      setIsImportingLandmarks(false);
    }
  };

  const mergeUpdateLandmarkGeoJson = async (points: any[]) => {
    if (!isAdmin || isImportingLandmarks) return;
    setIsImportingLandmarks(true);
    setImportNotice(null);
    try {
      if (points.length === 0) {
        setImportNotice({ type: 'error', message: 'No Point features found in uploaded GeoJSON.' });
        setImportProgress(null);
        setIsImportingLandmarks(false);
        return;
      }

      const confirmed = window.confirm(
        'This will MERGE uploaded landmark GeoJSON into existing data.\n\n' +
          'Enumerator-edited records are preserved.\n' +
          'Untouched landmark baseline records are refreshed from JSON.\n' +
          'No full delete is performed.\n\n' +
          'Continue?'
      );
      if (!confirmed) {
        setImportProgress(null);
        setIsImportingLandmarks(false);
        return;
      }

      const pointRecords = points.map((f: any, idx: number) => {
        const fid = normalizeLandmarkFid(f?.properties?.FID ?? f?.id ?? idx);
        const id = `landmark_${fid !== undefined ? fid : idx}`;
        return { id, fid, feature: f };
      });

      const featureById = new Map(features.map((f) => [f.id, f]));
      const landmarkByFid = new Map<string, GeoFeature>();
      for (const f of features) {
        if (f.type !== 'point') continue;
        const fid = normalizeLandmarkFid(f.attributes?.FID);
        if (fid === undefined) continue;
        landmarkByFid.set(String(fid), f);
      }

      const MAX_OPS = 450;
      let batch = writeBatch(db);
      let ops = 0;
      const commitIfNeeded = async (nextCost: number) => {
        if (ops + nextCost > MAX_OPS) {
          await batch.commit();
          batch = writeBatch(db);
          ops = 0;
        }
      };
      const commitBatch = async () => {
        if (ops > 0) {
          await batch.commit();
          batch = writeBatch(db);
          ops = 0;
        }
      };

      let processed = 0;
      let written = 0;
      let created = 0;
      let refreshed = 0;
      let preserved = 0;
      setImportProgress({ total: pointRecords.length, processed: 0, written: 0, previousRemoved: 0 });

      for (const rec of pointRecords) {
        const [lng, lat] = parsePointCoordinates(rec.feature?.geometry?.coordinates);
        const rawProps =
          rec.feature?.properties != null && typeof rec.feature.properties === 'object'
            ? (rec.feature.properties as Record<string, unknown>)
            : {};
        const normalizedAttrs = normalizeImportedLandmarkProperties(rawProps, rec.fid);

        const existingById = featureById.get(rec.id);
        const existingByFid = rec.fid !== undefined ? landmarkByFid.get(String(rec.fid)) : undefined;
        const existing = existingById || existingByFid;
        const targetId = existing?.id || rec.id;
        const ref = doc(db, 'features', targetId);

        const source = String(existing?.attributes?.__source || '');
        const hasUserEdits = !!existing && (
          existing.status !== 'pending' ||
          Boolean(existing.remarks) ||
          Boolean(existing.moveRemarks) ||
          Boolean(existing.newFeatureRemarks) ||
          Boolean(String(existing.attributes?.ChangeBy || '').trim()) ||
          Boolean(String(existing.attributes?.ChangeAt || '').trim()) ||
          source.includes('landmark_manual')
        );

        await commitIfNeeded(1);

        if (!existing) {
          batch.set(ref, {
            type: 'point',
            geometry: { type: 'Point', coordinates: [lng, lat] },
            attributes: withBaselineTaskWard({
              ...normalizedAttrs,
              __source: 'ccc_landmark'
            }),
            status: 'pending',
            createdBy: 'ccc_landmark_import',
            updatedBy: user?.email || 'ccc_landmark_import',
            updatedByUid: user?.uid || null,
            updatedAt: serverTimestamp()
          });
          created += 1;
          written += 1;
          ops += 1;
        } else if (hasUserEdits) {
          // Merge fresh file columns in; existing values win (enumerator/admin edits kept).
          const merged = sanitizeSlumOnlyFields({
            ...normalizedAttrs,
            ...(existing.attributes || {}),
            __source: source || 'ccc_landmark'
          });
          const preservedAttrs = withBaselineTaskWard(merged);
          batch.update(ref, {
            attributes: preservedAttrs,
            updatedAt: serverTimestamp()
          });
          preserved += 1;
          written += 1;
          ops += 1;
        } else {
          // Refresh untouched landmark baseline with latest JSON values.
          batch.update(ref, {
            geometry: { type: 'Point', coordinates: [lng, lat] },
            attributes: withBaselineTaskWard({
              ...normalizedAttrs,
              __source: 'ccc_landmark'
            }),
            updatedBy: user?.email || 'ccc_landmark_import',
            updatedByUid: user?.uid || null,
            updatedAt: serverTimestamp()
          });
          refreshed += 1;
          written += 1;
          ops += 1;
        }

        processed += 1;
        if (processed % 100 === 0 || processed === pointRecords.length) {
          setImportProgress({
            total: pointRecords.length,
            processed,
            written,
            previousRemoved: 0
          });
        }
      }

      await commitBatch();
      setImportNotice({
        type: 'success',
        message: `Upload merge complete. Created: ${created}, refreshed: ${refreshed}, preserved edited: ${preserved}.`
      });
      setAdminFeaturesRefreshKey((k) => k + 1);
    } catch (e) {
      console.error(e);
      setImportNotice({ type: 'error', message: 'Uploaded landmark merge failed: ' + e });
    } finally {
      setIsImportingLandmarks(false);
    }
  };

  const onUploadMergeFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const geo = JSON.parse(text);
      const points = Array.isArray(geo?.features)
        ? geo.features.filter((f: any) => f?.geometry?.type === 'Point')
        : [];
      await mergeUpdateLandmarkGeoJson(points);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImportNotice({ type: 'error', message: `Invalid upload file. ${message}` });
    } finally {
      if (e.target) e.target.value = '';
    }
  };

  const openUploadMergePicker = () => {
    if (isImportingLandmarks) return;
    uploadMergeInputRef.current?.click();
  };

  const downloadChangedLandmarkShp = async () => {
    if (!isAdmin) return;
    setImportNotice(null);

    const valuesEqual = (a: unknown, b: unknown) => {
      if (a === b) return true;
      if ((a === null || a === undefined || a === '') && (b === null || b === undefined || b === '')) {
        return true;
      }
      const an = Number(a);
      const bn = Number(b);
      if (Number.isFinite(an) && Number.isFinite(bn) && String(a).trim() !== '' && String(b).trim() !== '') {
        return an === bn;
      }
      return String(a ?? '') === String(b ?? '');
    };
    const isPointGeometrySame = (a: any, b: any) => {
      const ac = Array.isArray(a?.coordinates) ? a.coordinates : [];
      const bc = Array.isArray(b?.coordinates) ? b.coordinates : [];
      if (ac.length < 2 || bc.length < 2) return false;
      const ax = Number(ac[0]);
      const ay = Number(ac[1]);
      const bx = Number(bc[0]);
      const by = Number(bc[1]);
      if (![ax, ay, bx, by].every(Number.isFinite)) return false;
      const eps = 1e-9;
      return Math.abs(ax - bx) <= eps && Math.abs(ay - by) <= eps;
    };

    let baselineByFid = new Map<string, { geometry: any; properties: Record<string, any> }>();
    try {
      const baselineResp = await fetchLandmarkGeoJson();
      if (!baselineResp.ok) {
        throw new Error(`Failed to load baseline GeoJSON (${baselineResp.status})`);
      }
      const baseline = await baselineResp.json();
      const baselinePoints = Array.isArray(baseline?.features)
        ? baseline.features.filter((f: any) => f?.geometry?.type === 'Point')
        : [];
      baselineByFid = new Map(
        baselinePoints.map((f: any) => [
          String(f?.properties?.FID ?? ''),
          { geometry: f?.geometry, properties: f?.properties || {} }
        ])
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImportNotice({ type: 'error', message: `Failed to load baseline landmark data: ${message}` });
      return;
    }

    const changedFeatures = visibleFeatures.filter((feature) => {
      if (feature.geometry?.type !== 'Point') return false;
      const source = String(feature.attributes?.__source || '');
      const isLandmarkRelated = source.includes('landmark');
      if (!isLandmarkRelated) return false;

      // Newly added landmark points should always be exported as changed.
      if (source.includes('landmark_manual')) return true;

      const fid = feature.attributes?.FID;
      const baselineEntry = baselineByFid.get(String(fid ?? ''));
      if (!baselineEntry) return true;

      // Rejected/verified/any remarks imply change.
      if (
        feature.status !== 'pending' ||
        Boolean(feature.remarks) ||
        Boolean(feature.moveRemarks) ||
        Boolean(feature.newFeatureRemarks)
      ) return true;

      if (!isPointGeometrySame(feature.geometry, baselineEntry.geometry)) return true;

      const currentProps = Object.fromEntries(
        Object.entries(feature.attributes || {}).filter(([k]) => !k.startsWith('__'))
      );
      const baselineProps = baselineEntry.properties || {};
      const keys = new Set([...Object.keys(currentProps), ...Object.keys(baselineProps)]);
      for (const key of keys) {
        if (!valuesEqual(currentProps[key], baselineProps[key])) return true;
      }
      return false;
    });
    if (changedFeatures.length === 0) {
      setImportNotice({ type: 'error', message: 'No changed landmark point features available for SHP download.' });
      return;
    }

    const exportList = changedFeatures.filter(landmarkHasEnumeratorActivity);
    if (exportList.length === 0) {
      setImportNotice({
        type: 'error',
        message:
          'No enumerator-changed landmark points to export. (Automated import-only updates are excluded from Changed SHP.)'
      });
      return;
    }

    const idsPendingComplete = exportList
      .filter((f) => f.status === 'pending' && isLandmarkPointFormComplete(f))
      .map((f) => f.id);

    let bulkVerifyTime: Date | null = null;
    let bulkVerifyBy = '';

    if (idsPendingComplete.length > 0) {
      if (!user) {
        setImportNotice({ type: 'error', message: 'You must be signed in to finalize verification.' });
        return;
      }
      bulkVerifyTime = new Date();
      bulkVerifyBy = user.email || '';
      const chunkSize = 400;
      try {
        for (let i = 0; i < idsPendingComplete.length; i += chunkSize) {
          const chunk = idsPendingComplete.slice(i, i + chunkSize);
          const batch = writeBatch(db);
          for (const id of chunk) {
            batch.update(doc(db, 'features', id), {
              status: 'verified',
              verifiedAt: serverTimestamp(),
              verifiedBy: bulkVerifyBy,
              updatedBy: user.email,
              updatedByUid: user.uid,
              updatedAt: serverTimestamp()
            });
          }
          await batch.commit();
        }
      } catch (error) {
        console.error(error);
        setImportNotice({
          type: 'error',
          message: `Could not mark pending records as verified: ${error instanceof Error ? error.message : String(error)}`
        });
        return;
      }
      setAdminFeaturesRefreshKey((k) => k + 1);
    }

    const verifiedIdSet = new Set(idsPendingComplete);
    const featuresForShp = exportList.map((f) => {
      if (!verifiedIdSet.has(f.id)) return f;
      return {
        ...f,
        status: 'verified' as const,
        ...(bulkVerifyTime && {
          verifiedAt: bulkVerifyTime,
          verifiedBy: bulkVerifyBy
        })
      } as GeoFeature;
    });

    const exportPayload = {
      type: 'FeatureCollection',
      name: 'changed_landmarks',
      features: mapLandmarkFeaturesToShpGeoJsonFeatures(featuresForShp, approvedEnumeratorsAdmin)
    };
    // EPSG:4326 WGS84 projection for shapefile .prj
    const wgs84Prj =
      'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",' +
      'SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
      'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

    try {
      const zipResult = await shpwrite.zip(exportPayload as any, {
        folder: 'changed_landmarks',
        types: { point: 'changed_landmarks' },
        prj: wgs84Prj,
        outputType: 'blob',
        compression: 'STORE'
      });

      let blob = zipResult instanceof Blob
        ? zipResult
        : new Blob([zipResult as BlobPart], { type: 'application/zip' });
      const propRowsChanged = (exportPayload.features as Array<{ properties?: Record<string, unknown> }>).map(
        (f) => (f.properties ?? {}) as Record<string, unknown>
      );
      blob = await patchShapefileZipUtf8Dbf(blob, 'changed_landmarks', 'changed_landmarks', propRowsChanged);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `changed_landmarks_${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      const exported = (exportPayload.features as any[]).length;
      const verifiedCount = idsPendingComplete.length;
      setImportNotice({
        type: 'success',
        message:
          verifiedCount > 0
            ? `SHP ready: ${exported} point(s). Marked ${verifiedCount} complete pending record(s) as verified.`
            : `SHP download ready. Exported ${exported} enumerator-changed point feature(s) as ZIP.`
      });
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      setImportNotice({ type: 'error', message: `Failed to generate SHP ZIP download: ${message}` });
    }
  };

  const downloadFullLandmarkShp = async () => {
    if (!isAdmin) return;
    setImportNotice(null);

    const allLandmarkFeatures = visibleFeatures.filter((feature) => {
      if (feature.geometry?.type !== 'Point') return false;
      const source = String(feature.attributes?.__source || '');
      return source.includes('landmark');
    });

    if (allLandmarkFeatures.length === 0) {
      setImportNotice({ type: 'error', message: 'No landmark point features available for full SHP download.' });
      return;
    }

    const exportPayload = {
      type: 'FeatureCollection',
      name: 'all_landmarks',
      features: mapLandmarkFeaturesToShpGeoJsonFeatures(allLandmarkFeatures, approvedEnumeratorsAdmin)
    };

    // EPSG:4326 WGS84 projection for shapefile .prj
    const wgs84Prj =
      'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",' +
      'SPHEROID["WGS_1984",6378137.0,298.257223563]],' +
      'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

    try {
      const zipResult = await shpwrite.zip(exportPayload as any, {
        folder: 'all_landmarks',
        types: { point: 'all_landmarks' },
        prj: wgs84Prj,
        outputType: 'blob',
        compression: 'STORE'
      });

      let blob = zipResult instanceof Blob
        ? zipResult
        : new Blob([zipResult as BlobPart], { type: 'application/zip' });
      const propRowsAll = (exportPayload.features as Array<{ properties?: Record<string, unknown> }>).map(
        (f) => (f.properties ?? {}) as Record<string, unknown>
      );
      blob = await patchShapefileZipUtf8Dbf(blob, 'all_landmarks', 'all_landmarks', propRowsAll);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `all_landmarks_${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      setImportNotice({
        type: 'success',
        message: `Full SHP ready. Exported ${(exportPayload.features as any[]).length} landmark point feature(s) as ZIP.`
      });
    } catch (error) {
      console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      setImportNotice({ type: 'error', message: `Failed to generate full SHP ZIP download: ${message}` });
    }
  };

  const handleMapClick = async (lat: number, lng: number) => {
    if (!user) return;

    if (movingFeature) {
      if (movingFeature.type !== 'point') {
        setMovingFeature(null);
        return;
      }
      try {
        const latestFeature =
          features.find((f) => f.id === movingFeature.id) || movingFeature;
        const previousGeometry = latestFeature.geometry;
        const nextGeometry = { type: 'Point' as const, coordinates: [lng, lat] };
        const prevLng = Number(previousGeometry?.coordinates?.[0]);
        const prevLat = Number(previousGeometry?.coordinates?.[1]);
        const moveRemark = `Feature moved from (${Number.isFinite(prevLat) ? prevLat.toFixed(6) : 'n/a'}, ${Number.isFinite(prevLng) ? prevLng.toFixed(6) : 'n/a'}) to (${lat.toFixed(6)}, ${lng.toFixed(6)}) by ${user.email || 'user'} at ${new Date().toISOString()}`;
        await updateDoc(doc(db, 'features', movingFeature.id), {
          geometry: nextGeometry,
          moveRemarks: moveRemark,
          updatedBy: user.email || 'user',
          updatedByUid: user.uid,
          updatedAt: serverTimestamp(),
          ...(location && {
            collectorLocation: {
              lat: location.lat,
              lng: location.lng,
              accuracy: location.accuracy
            }
          })
        });

        setSelectedFeature(null);
        setLastMovedPoint({
          featureId: movingFeature.id,
          featureName: String(movingFeature.attributes?.name || 'Selected Landmark'),
          previousGeometry
        });
        setMovingFeature(null);
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, 'features');
      }
      return;
    }

    if (!isAddingFeature) return;

    try {
      let geometry: any;
      if (isAddingFeature === 'point') {
        // Enumerator can add landmark points only when standing within NEW_POINT_ADD_PROXIMITY_METERS of clicked point.
        if (!isAdmin) {
          if (!location) {
            requestLocation();
            alert('GPS location is required. Please allow location access in browser and wait for GPS lock.');
            return;
          }
          const d = distanceMeters(location.lat, location.lng, lat, lng);
          if (d > NEW_POINT_ADD_PROXIMITY_METERS) {
            alert(
              `You are ${d.toFixed(1)}m away from the selected point. Move within ${NEW_POINT_ADD_PROXIMITY_METERS}m to add a landmark point.`
            );
            return;
          }
        }
        geometry = { type: 'Point', coordinates: [lng, lat] };

        // New point creation now happens via attribute editor + save.
        setSelectedFeature({
          id: `draft_${Date.now()}`,
          type: 'point',
          geometry,
          attributes: {
            name: '',
            Category: 'Landmark',
            Type: 'Point',
            Ownership: '',
            Ward_Name: '',
            Zone: '',
            __source: 'landmark_manual'
          },
          status: 'pending',
          createdBy: user.email || 'user',
          updatedBy: user.email || 'user',
          updatedAt: new Date().toISOString(),
          ...(location && {
            collectorLocation: {
              lat: location.lat,
              lng: location.lng,
              accuracy: location.accuracy
            }
          })
        } as GeoFeature);
        setIsAddingFeature(null);
        return;
      } else if (isAddingFeature === 'line') {
        // Simple point-to-line for now or multi-click logic
        geometry = { type: 'LineString', coordinates: [[lng, lat], [lng + 0.001, lat + 0.001]] };
      } else {
        geometry = { type: 'Polygon', coordinates: [[[lng, lat], [lng + 0.001, lat], [lng + 0.001, lat + 0.001], [lng, lat + 0.001], [lng, lat]]] };
      }

      await addDoc(collection(db, 'features'), {
        type: isAddingFeature,
        geometry,
        attributes: {
          name: isAddingFeature === 'point' ? 'New Landmark Point' : 'New ' + isAddingFeature,
          Category: isAddingFeature === 'point' ? 'Landmark' : '',
          Type: isAddingFeature === 'point' ? 'Point' : '',
          created_at: new Date().toISOString(),
          __source: isAddingFeature === 'point' ? 'landmark_manual' : 'manual'
        },
        status: 'pending',
        newFeatureRemarks: 'New added feature remarks.',
        createdBy: user.email,
        createdByUid: user.uid,
        updatedBy: user.email,
        updatedAt: serverTimestamp(),
        ...(location && {
          collectorLocation: {
            lat: location.lat,
            lng: location.lng,
            accuracy: location.accuracy
          }
        })
      });

      setIsAddingFeature(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'features');
    }
  };

  const handleMapFeatureSelect = useCallback((feature: GeoFeature) => {
    if (movingFeatureRef.current) return;
    setSelectedFeature(feature);
    setFeatureFocusRequestKey((k) => k + 1);
    setActiveTab('map');
  }, []);

  const handleCreateFeatureFromEditor = async (payload: { attributes: Record<string, any>; status: 'pending' | 'verified' | 'rejected' }) => {
    if (!user || !selectedFeature) return;
    await addDoc(collection(db, 'features'), {
      type: selectedFeature.type,
      geometry: selectedFeature.geometry,
      attributes: withBaselineTaskWard(payload.attributes),
      status: payload.status,
      newFeatureRemarks: 'New added feature remarks.',
      createdBy: user.email,
      createdByUid: user.uid,
      updatedBy: user.email,
      updatedByUid: user.uid,
      updatedAt: serverTimestamp(),
      ...(payload.status === 'verified' && {
        verifiedAt: serverTimestamp(),
        verifiedBy: user.email || ''
      }),
      ...(location && {
        collectorLocation: {
          lat: location.lat,
          lng: location.lng,
          accuracy: location.accuracy
        }
      })
    });
  };

  const handleLandmarkPointSelect = async (point: { lat: number; lng: number; properties: Record<string, any> }) => {
    if (!user) return;

    const fid = normalizeLandmarkFid(point.properties?.FID);
    const attributes = withBaselineTaskWard({
      ...point.properties,
      ...(fid !== undefined ? { FID: fid } : {}),
      __source: 'ccc_landmark_geojson'
    });

    const existing = features.find((f) => {
      if (f.type !== 'point') return false;
      if (fid !== undefined) {
        return fidsEqual(f.attributes?.FID, fid);
      }
      if (!Array.isArray(f.geometry?.coordinates)) return false;
      return (
        Math.abs((f.geometry.coordinates[1] ?? 0) - point.lat) < 0.0000001 &&
        Math.abs((f.geometry.coordinates[0] ?? 0) - point.lng) < 0.0000001
      );
    });

    if (existing) {
      handleMapFeatureSelect(existing);
      return;
    }

    try {
      // If landmark does not exist in Firestore yet, create it so it can be edited.
      // No GPS-distance restriction here: proximity rule only for
      // explicit "add feature" mode (map click), not edit/delete/attribute edit flow.

      const featureId = fid !== undefined ? `landmark_${fid}` : null;
      if (featureId) {
        const ref = doc(db, 'features', featureId);
        await setDoc(
          ref,
          {
            type: 'point',
            geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
            attributes,
            status: 'pending',
            createdBy: user.email,
            createdByUid: user.uid,
            updatedBy: user.email,
            updatedByUid: user.uid,
            updatedAt: serverTimestamp(),
            ...(location && {
              collectorLocation: {
                lat: location.lat,
                lng: location.lng,
                accuracy: location.accuracy
              }
            })
          },
          { merge: true }
        );

        handleMapFeatureSelect({
          id: featureId,
          type: 'point',
          geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
          attributes,
          status: 'pending',
          createdBy: user.email || 'user',
          updatedBy: user.email || 'user',
          updatedAt: new Date().toISOString()
        } as GeoFeature);
        return;
      }

      const docRef = await addDoc(collection(db, 'features'), {
        type: 'point',
        geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
        attributes,
        status: 'pending',
        createdBy: user.email,
        createdByUid: user.uid,
        updatedBy: user.email,
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
        ...(location && {
          collectorLocation: {
            lat: location.lat,
            lng: location.lng,
            accuracy: location.accuracy
          }
        })
      });

      handleMapFeatureSelect({
        id: docRef.id,
        type: 'point',
        geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
        attributes,
        status: 'pending',
        createdBy: user.email || 'user',
        updatedBy: user.email || 'user',
        updatedAt: new Date().toISOString()
      } as GeoFeature);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'features');
    }
  };

  const startMoveFeature = (feature: GeoFeature) => {
    if (feature.type !== 'point') {
      alert('Only point features can be moved.');
      return;
    }
    setMovingFeature(feature);
    setIsAddingFeature(null);
    setSelectedFeature(null);
    setActiveTab('map');
  };

  const cancelMoveFeature = () => {
    setMovingFeature(null);
  };

  const undoLastMove = async () => {
    if (!user || !lastMovedPoint) return;
    try {
      const undoLng = Number(lastMovedPoint.previousGeometry?.coordinates?.[0]);
      const undoLat = Number(lastMovedPoint.previousGeometry?.coordinates?.[1]);
      const undoRemark = `Move undone to (${Number.isFinite(undoLat) ? undoLat.toFixed(6) : 'n/a'}, ${Number.isFinite(undoLng) ? undoLng.toFixed(6) : 'n/a'}) by ${user.email || 'user'} at ${new Date().toISOString()}`;
      await updateDoc(doc(db, 'features', lastMovedPoint.featureId), {
        geometry: lastMovedPoint.previousGeometry,
        moveRemarks: undoRemark,
        updatedBy: user.email || 'user',
        updatedByUid: user.uid,
        updatedAt: serverTimestamp()
      });
      setSelectedFeature((prev) =>
        prev && prev.id === lastMovedPoint.featureId
          ? ({ ...prev, geometry: lastMovedPoint.previousGeometry } as GeoFeature)
          : prev
      );
      setLastMovedPoint(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, 'features');
    }
  };

  if (authLoading) return (
    <div className="h-screen flex items-center justify-center bg-slate-50">
      <div className="animate-bounce flex space-x-2">
        <div className="h-3 w-3 bg-blue-600 rounded-full"></div>
        <div className="h-3 w-3 bg-blue-600 rounded-full"></div>
        <div className="h-3 w-3 bg-blue-600 rounded-full"></div>
      </div>
    </div>
  );

  if (!user) return <LoginScreen />;

  // If auth succeeded but profile is still loading, don't bounce back to login.
  if (!userProfile) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6 font-sans">
        <div className="max-w-md w-full bg-white rounded-3xl shadow-xl p-8 border border-slate-100 text-center">
          <div className="mx-auto w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-200 mb-4">
            <Shield size={28} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-800">Checking your access</h1>
          <p className="text-slate-500 text-sm mt-2">Please wait...</p>
        </div>
      </div>
    );
  }

  if (userProfile.status === 'pending') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6 font-sans">
        <div className="max-w-md w-full bg-white rounded-3xl shadow-xl p-8 border border-slate-100">
          <div className="flex flex-col items-center text-center mb-6">
            <div className="w-16 h-16 bg-amber-500 rounded-2xl flex items-center justify-center shadow-lg shadow-amber-200 mb-4">
              <Clock size={28} className="text-white" />
            </div>
            <h1 className="text-2xl font-bold text-slate-800">Approval Pending</h1>
            <p className="text-slate-500 text-sm mt-2">
              Your account is waiting for admin approval. You can sign in, but you will be able to access the portal once approved.
            </p>
            <p className="text-[10px] text-slate-400 mt-3">
              {userProfile.email}
            </p>
          </div>

          <div className="space-y-3">
            <button
              onClick={() => void logout()}
              className="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold py-3 rounded-2xl transition-all shadow-lg active:scale-[0.98]"
            >
              Log out
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (userProfile.status === 'rejected') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6 font-sans">
        <div className="max-w-md w-full bg-white rounded-3xl shadow-xl p-8 border border-slate-100">
          <div className="flex flex-col items-center text-center mb-6">
            <div className="w-16 h-16 bg-red-500 rounded-2xl flex items-center justify-center shadow-lg shadow-red-200 mb-4">
              <AlertCircle size={28} className="text-white" />
            </div>
            <h1 className="text-2xl font-bold text-slate-800">Access Rejected</h1>
            <p className="text-slate-500 text-sm mt-2">
              Your account was rejected by the administrator. Please contact support if you believe this is a mistake.
            </p>
            <p className="text-[10px] text-slate-400 mt-3">
              {userProfile.email}
            </p>
          </div>

          <button
            onClick={() => void logout()}
            className="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold py-3 rounded-2xl transition-all shadow-lg active:scale-[0.98]"
          >
            Log out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] max-h-[100dvh] min-h-0 flex-col bg-slate-50 font-sans text-slate-800">
      {/* Header */}
      <header className="h-16 bg-white border-b border-slate-200 px-4 flex items-center justify-between shadow-sm z-[1001]">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 p-2 rounded-xl text-white">
            <Compass size={24} />
          </div>
          <div>
            <h1 className="font-bold text-slate-900 leading-tight">EQMS Geosurvey</h1>
            <p className="text-[10px] text-slate-400 font-medium tracking-wide">Collect and validate geospatial data from ground level</p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="hidden md:flex items-center gap-2 px-3 py-1.5 bg-slate-50 rounded-full border border-slate-100">
            <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
            <span className="text-xs font-medium text-slate-600">Live Sync Active</span>
          </div>
          {assignedWardsForFilter.length > 0 && !isAdmin && (
            <div
              className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 bg-indigo-50 rounded-full border border-indigo-100 max-w-[min(100vw-12rem,320px)]"
              title={`You only see features whose task ward (landmark import / map) matches one of: ${assignedWardsForFilter.join(', ')}. Edits to Ward_Name in attributes do not move tasks.`}
            >
              <MapPin size={14} className="text-indigo-600 shrink-0" />
              <span className="text-xs font-semibold text-indigo-800 truncate">
                Wards:{' '}
                {assignedWardsForFilter.length <= 2
                  ? assignedWardsForFilter.join(', ')
                  : `${assignedWardsForFilter.length} selected (${assignedWardsForFilter.slice(0, 2).join(', ')}…)`}
              </span>
            </div>
          )}
          
          <div className="flex items-center gap-3 border-l border-slate-200 pl-4 ml-4">
            {isAdmin && (
              <>
                <button 
                  onClick={() => setShowUserManagement(true)}
                  className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                  title="Manage Users"
                >
                  <UserPlus size={20} />
                </button>
              </>
            )}
            <div className="text-right hidden sm:block">
              <p className="text-xs font-bold text-slate-900">{userProfile?.displayName || user.email}</p>
              <p className="text-[10px] text-blue-600 font-bold uppercase">{isAdmin ? 'ADMIN' : 'ENUMERATOR'}</p>
            </div>
            <button 
              onClick={logout}
              className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
              title="Logout"
            >
              <LogOut size={20} />
            </button>
          </div>
        </div>
      </header>

      {/* Main Layout */}
      <div className="flex-1 flex overflow-hidden relative">
        <main className="flex-1 flex flex-col">
          {activeTab === 'map' ? (
            <MapComponent 
              features={visibleFeatures}
              wards={wardsData}
              enumeratorLandmarkWardFilter={
                !isAdmin ? assignedWardsForFilter : undefined
              }
              onFeatureSelect={handleMapFeatureSelect}
              onRequestMoveFeature={startMoveFeature}
              onCancelMoveFeature={cancelMoveFeature}
              onLandmarkPointSelect={handleLandmarkPointSelect}
              selectedFeatureId={movingFeature?.id ?? selectedFeature?.id}
              featureFocusRequestKey={featureFocusRequestKey}
              movingFeatureId={movingFeature?.id || null}
              onMapClick={handleMapClick}
              addFeatureType={isAddingFeature}
              showPointAddBuffer={!isAdmin && isAddingFeature === 'point'}
              landmarkGeoJsonRefreshKey={isAdmin ? adminFeaturesRefreshKey : 0}
            />
          ) : (
            <div className="p-6 overflow-y-auto w-full">
              <div className="max-w-4xl mx-auto space-y-4">
                <h2 className="text-xl font-bold flex items-center gap-2 mb-6">
                  <List size={24} className="text-blue-600" />
                  Attribute Data Table (Ward-wise)
                </h2>
                <div className="bg-white rounded-xl border border-slate-200 p-3">
                  <input
                    type="text"
                    value={tableSearchQuery}
                    onChange={(e) => setTableSearchQuery(e.target.value)}
                    placeholder="Search by ward, name, FID, category, type, status..."
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  />
                </div>
                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
                  <table className="w-full text-left border-collapse">
                    <thead className="bg-slate-50 border-b border-slate-100">
                      <tr>
                        <th className="px-4 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-wider">Ward / Feature</th>
                        <th className="px-4 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-wider">Type / Enumerator</th>
                        <th className="px-4 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-wider">Status</th>
                        <th className="px-4 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-wider">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredGroupedWardRows.map((row) => {
                        const expanded = expandedWardKeys.includes(row.wardKey);
                        return (
                          <React.Fragment key={row.wardKey}>
                            <tr className="bg-slate-50/80">
                              <td className="px-4 py-3">
                                <button
                                  type="button"
                                  onClick={() => toggleWardExpanded(row.wardKey)}
                                  className="inline-flex items-center gap-2 text-sm font-bold text-slate-800"
                                >
                                  <span className="inline-flex items-center justify-center h-5 w-5 rounded border border-slate-300 bg-white text-slate-700 text-xs">
                                    {expanded ? '−' : '+'}
                                  </span>
                                  <span>
                                    Ward {parseWardNumber(row.wardLabel) ?? row.wardLabel}{' '}
                                    <span className="text-[10px] text-slate-500">
                                      (Total Landmark: {row.features.length})
                                    </span>
                                  </span>
                                </button>
                              </td>
                              <td className="px-4 py-3 text-xs text-slate-600">
                                {isAdmin ? (
                                  <>
                                    <span className="font-semibold text-slate-500">Enumerator: </span>
                                    {wardOwnerByKey.get(row.wardKey) || 'Not assigned'}
                                  </>
                                ) : (
                                  'Assigned ward scope'
                                )}
                              </td>
                              <td className="px-4 py-3 text-xs text-slate-500">
                                {row.features.filter((f) => getFeatureStatusFromQc(f) === 'pending').length} P /{' '}
                                {row.features.filter((f) => getFeatureStatusFromQc(f) === 'verified').length} V /{' '}
                                {row.features.filter((f) => getFeatureStatusFromQc(f) === 'rejected').length} R
                              </td>
                              <td className="px-4 py-3 text-xs text-slate-400">
                                {expanded ? 'Expanded' : 'Collapsed'}
                              </td>
                            </tr>

                            {expanded &&
                              row.features.map((f) => {
                                const effectiveStatus = getFeatureStatusFromQc(f);
                                return (
                                <tr key={f.id} className="hover:bg-slate-50/50 transition-colors">
                                  <td className="px-4 py-3">
                                    <span className="text-sm font-semibold">
                                      {f.attributes?.name ?? f.attributes?.Name ?? 'Unnamed Feature'}
                                    </span>
                                    <div className="flex gap-1 mt-1 flex-wrap">
                                      {landmarkAttributesForTable(f.attributes || {}).map(([k, v]) => (
                                        <span key={k} className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded uppercase">{k}: {v}</span>
                                      ))}
                                    </div>
                                  </td>
                                  <td className="px-4 py-3 capitalize font-medium text-slate-600 text-sm">{f.type}</td>
                                  <td className="px-4 py-3">
                                    <span className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase ${
                                      effectiveStatus === 'verified' ? 'bg-green-100 text-green-700' :
                                      effectiveStatus === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
                                    }`}>
                                      {effectiveStatus}
                                    </span>
                                  </td>
                                  <td className="px-4 py-3">
                                    <button
                                      onClick={() => { setSelectedFeature(f); setActiveTab('map'); }}
                                      className="text-blue-600 text-xs font-bold hover:underline"
                                    >
                                      Edit on Map
                                    </button>
                                    {f.type === 'point' && (
                                      <>
                                        <button
                                          onClick={() => startMoveFeature(f)}
                                          className="ml-3 text-indigo-600 text-xs font-bold hover:underline"
                                        >
                                          Move Point
                                        </button>
                                        {movingFeature?.id === f.id && (
                                          <button
                                            onClick={cancelMoveFeature}
                                            className="ml-3 text-slate-600 text-xs font-bold hover:underline"
                                          >
                                            Cancel Move
                                          </button>
                                        )}
                                      </>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </main>

        {/* User Management Overlay */}
        {showUserManagement && (
          <div className="absolute top-0 right-0 h-full z-[1003] flex animate-in slide-in-from-right duration-300">
            <UserManagement onClose={() => setShowUserManagement(false)} />
          </div>
        )}

        {/* Questionnaire Manager Overlay */}
        {showQuestionnaireManager && (
          <div className="absolute top-0 right-0 h-full z-[1003] flex animate-in slide-in-from-right duration-300">
            <QuestionnaireManager
              onClose={() => setShowQuestionnaireManager(false)}
              onSelectQuestionnaire={(questionnaire) => {
                setSelectedQuestionnaire(questionnaire);
                setShowQuestionnaireManager(false);
              }}
            />
          </div>
        )}

        {/* Questionnaire Form Overlay */}
        {selectedQuestionnaire && (
          <div className="absolute top-0 right-0 h-full z-[1003] flex animate-in slide-in-from-right duration-300">
            <QuestionnaireForm
              questionnaire={selectedQuestionnaire}
              onClose={() => setSelectedQuestionnaire(null)}
              initialLocation={questionnaireLocation || undefined}
            />
          </div>
        )}

        {/* Feature Editor — only when a feature is explicitly selected for edit, not during move mode */}
        {selectedFeature && !movingFeature && (
          <div className="absolute top-0 right-0 h-full z-[1002] flex animate-in slide-in-from-right duration-300">
            <FeatureEditor
              feature={selectedFeature}
              allFeatures={features}
              wardOptions={wardOptionsForEditor}
              categoryOptions={categoryOptionsForEditor}
              taskWardFreeze={editorTaskWardFreeze}
              onClose={() => {
                setSelectedFeature(null);
                setMovingFeature(null);
              }} 
              isAdmin={isAdmin}
              isNewFeature={selectedFeature.id.startsWith('draft_')}
              onCreateFeature={handleCreateFeatureFromEditor}
              onPersistSuccess={() => {
                if (isAdmin) setAdminFeaturesRefreshKey((k) => k + 1);
                else setEnumeratorFeaturesRefreshKey((k) => k + 1);
              }}
            />
          </div>
        )}

        {/* Toolbar Floating — bottom offset includes safe area so bar stays above mobile browser / home indicator */}
        <div
          className="absolute left-1/2 z-[1001] flex max-w-[calc(100vw-1rem)] items-center bg-white/80 backdrop-blur-md rounded-2xl shadow-2xl border border-white/50 p-1.5 ring-1 ring-slate-200 -translate-x-1/2 bottom-[calc(1.25rem+env(safe-area-inset-bottom,0px))]"
        >
          <button 
            onClick={() => setActiveTab('map')}
            className={`flex items-center gap-2 px-3 py-2 sm:px-4 sm:py-2.5 rounded-xl text-sm font-bold transition-all ${activeTab === 'map' ? 'bg-blue-600 text-white shadow-lg shadow-blue-200' : 'text-slate-500 hover:bg-slate-50'}`}
          >
            <MapIcon size={18} className="shrink-0" aria-hidden /> Map View
          </button>
          <button 
            onClick={() => setActiveTab('list')}
            className={`flex items-center gap-2 px-3 py-2 sm:px-4 sm:py-2.5 rounded-xl text-sm font-bold transition-all ${activeTab === 'list' ? 'bg-blue-600 text-white shadow-lg shadow-blue-200' : 'text-slate-500 hover:bg-slate-50'}`}
          >
            <List size={18} className="shrink-0" aria-hidden /> Table List
          </button>
          {!isAdmin && (
            <>
              <div className="w-px h-6 bg-slate-200 mx-2" />
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => {
                    const next = isAddingFeature === 'point' ? null : 'point';
                    setIsAddingFeature(next);
                    if (next === 'point') {
                      requestLocation();
                      if (gpsError) {
                        alert(`Location access issue: ${gpsError}. Please allow location permission in your browser.`);
                      }
                    }
                  }}
                  className={`p-2.5 rounded-xl transition-all ${isAddingFeature === 'point' ? 'bg-blue-100 text-blue-600 ring-2 ring-blue-500 ring-inset' : 'text-slate-400 hover:bg-slate-50 hover:text-slate-600'}`}
                  title="Add point"
                >
                  <MapPin size={20} />
                </button>
              </div>
            </>
          )}
          <div className="w-px h-6 bg-slate-200 mx-2" />
        </div>

        {/* Quick Stats Floating (Admin) */}
        {isAdmin && (
          <div className="absolute top-4 left-4 z-[1000] flex flex-col gap-2">
            <div
              className="qc-panel-scroll bg-white/90 backdrop-blur-md p-3 pr-2 rounded-2xl shadow-lg border border-white/50 w-72 max-w-[calc(100vw-2rem)] max-h-[calc(100vh-6rem)] overflow-y-scroll overscroll-contain"
            >
              <div className="flex items-center gap-2 mb-3">
                <Shield size={16} className="text-blue-600" />
                <span className="text-xs font-bold uppercase tracking-wider">Quality Control</span>
              </div>
              <div className="space-y-3">
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">Verified</span>
                  <span className="font-bold text-green-600">{enumeratorTaskStats.verified}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">Pending</span>
                  <span className="font-bold text-amber-600">{enumeratorTaskStats.pending}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">Rejected</span>
                  <span className="font-bold text-red-600">{enumeratorTaskStats.rejected}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">New Added</span>
                  <span className="font-bold text-violet-700">{enumeratorTaskStats.newAdded}</span>
                </div>
                <div className="flex justify-between items-center text-xs">
                  <span className="text-slate-500">Landmarks (imported)</span>
                  <span className="font-bold">{importedLandmarkFeatures.length}</span>
                </div>
                <div className="flex justify-between items-center text-xs border-t border-slate-100 pt-2">
                  <span className="text-slate-500">Total (all)</span>
                  <span className="font-bold">{visibleFeatures.length}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setAdminFeaturesRefreshKey((k) => k + 1)}
                  disabled={featuresLoading}
                  title="Reloads Firestore features and re-fetches landmark reference GeoJSON (no stale browser cache)."
                  className="w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-[10px] font-bold uppercase transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-1"
                >
                  <RefreshCw size={12} className={featuresLoading ? 'animate-spin' : ''} />
                  {featuresLoading ? 'Loading…' : 'Refresh map data'}
                </button>
                <button 
                  onClick={importLandmarkGeoJson}
                  disabled={isImportingLandmarks}
                  className="w-full mt-1 py-2 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded-lg text-[10px] font-bold uppercase transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {isImportingLandmarks ? 'Importing Landmarks...' : 'Import Landmark GeoJSON'}
                </button>
                <button
                  onClick={openUploadMergePicker}
                  disabled={isImportingLandmarks}
                  className="w-full py-2 bg-emerald-100 hover:bg-emerald-200 text-emerald-700 rounded-lg text-[10px] font-bold uppercase transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  Upload + Merge Landmark GeoJSON
                </button>
                <input
                  ref={uploadMergeInputRef}
                  type="file"
                  accept=".geojson,.json,application/geo+json,application/json"
                  className="hidden"
                  onChange={onUploadMergeFileSelected}
                />
                {importProgress && (
                  <div className="space-y-1">
                    <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-600 transition-all duration-200"
                        style={{
                          width: `${Math.min(
                            100,
                            Math.round((importProgress.processed / Math.max(1, importProgress.total)) * 100)
                          )}%`
                        }}
                      />
                    </div>
                    <p className="text-[10px] text-slate-600">
                      {importProgress.processed}/{importProgress.total} processed | Written: {importProgress.written} | Previous data removed: {importProgress.previousRemoved}
                    </p>
                  </div>
                )}
                <button
                  onClick={downloadChangedLandmarkShp}
                  disabled={isImportingLandmarks}
                  className="w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-[10px] font-bold uppercase transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  Download Changed SHP
                </button>
                <button
                  onClick={downloadFullLandmarkShp}
                  disabled={isImportingLandmarks}
                  className="w-full py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-[10px] font-bold uppercase transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  Download Full SHP
                </button>
                {importNotice && (
                  <div
                    className={`text-[10px] font-semibold rounded-lg px-2 py-1 ${
                      importNotice.type === 'success'
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-red-100 text-red-700'
                    }`}
                  >
                    {importNotice.message}
                  </div>
                )}

                <div className="border-t border-slate-200 pt-3 mt-1">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Users size={14} className="text-slate-600 shrink-0" />
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600">
                      By enumerator
                    </span>
                  </div>
                  <p className="text-[9px] text-slate-400 mb-2 leading-snug">
                    Imported + new added landmark points: pending / verified / rejected by task ward (same rules as map).
                  </p>
                  <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-100">
                    <table className="w-full text-[10px]">
                      <thead>
                        <tr className="bg-slate-50 text-slate-500">
                          <th className="text-left px-1.5 py-1 font-semibold">Name</th>
                          <th className="text-center px-0.5 py-1 w-6 font-semibold text-amber-600" title="Pending">
                            P
                          </th>
                          <th className="text-center px-0.5 py-1 w-6 font-semibold text-green-600" title="Verified">
                            V
                          </th>
                          <th className="text-center px-0.5 py-1 w-6 font-semibold text-red-600" title="Rejected">
                            R
                          </th>
                          <th className="text-center px-0.5 py-1 w-7 font-semibold text-violet-700" title="New Added">
                            N
                          </th>
                          <th className="text-center px-0.5 py-1 w-6 font-semibold text-slate-600" title="Total">
                            Σ
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {adminLandmarksByEnumerator.rows.map((r) => (
                          <tr key={r.email} className="border-t border-slate-100">
                            <td className="px-1.5 py-1 text-slate-800 truncate max-w-[7rem]" title={r.email}>
                              {r.displayName}
                            </td>
                            <td className="text-center py-1 font-semibold text-amber-600">{r.pending}</td>
                            <td className="text-center py-1 font-semibold text-green-600">{r.verified}</td>
                            <td className="text-center py-1 font-semibold text-red-600">{r.rejected}</td>
                            <td className="text-center py-1 font-semibold text-violet-700">{r.newAdded}</td>
                            <td className="text-center py-1 font-semibold text-slate-700">{r.total}</td>
                          </tr>
                        ))}
                        {adminLandmarksByEnumerator.unassigned && (
                          <tr className="border-t border-amber-100 bg-amber-50/60">
                            <td className="px-1.5 py-1 text-amber-900 font-medium truncate max-w-[7rem]">
                              {adminLandmarksByEnumerator.unassigned.displayName}
                            </td>
                            <td className="text-center py-1 font-bold text-amber-800">
                              {adminLandmarksByEnumerator.unassigned.pending}
                            </td>
                            <td className="text-center py-1 font-bold text-green-800">
                              {adminLandmarksByEnumerator.unassigned.verified}
                            </td>
                            <td className="text-center py-1 font-bold text-red-800">
                              {adminLandmarksByEnumerator.unassigned.rejected}
                            </td>
                            <td className="text-center py-1 font-bold text-violet-800">
                              {adminLandmarksByEnumerator.unassigned.newAdded}
                            </td>
                            <td className="text-center py-1 font-bold text-slate-800">
                              {adminLandmarksByEnumerator.unassigned.total}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Quality Control — enumerator (assigned wards scope); map tab only, hidden on Table List */}
        {showEnumeratorQualityPanel && activeTab === 'map' && (
          <div className="absolute top-4 left-4 z-[1000] flex flex-col gap-2">
            <div
              className={`bg-white/90 backdrop-blur-md rounded-2xl shadow-lg border border-white/50 ${
                enumeratorQcExpanded ? 'p-3 w-52' : 'p-1.5 pl-2 pr-2 w-auto'
              }`}
            >
              <div
                className={`flex items-center justify-between gap-1.5 ${enumeratorQcExpanded ? 'mb-2' : ''}`}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <Activity size={16} className="text-indigo-600 shrink-0" />
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-800">
                    {enumeratorQcExpanded ? 'Quality Control' : 'QC'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setEnumeratorQcExpanded((v) => !v)}
                  className="h-6 w-6 shrink-0 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 text-sm font-bold leading-none flex items-center justify-center"
                  title={enumeratorQcExpanded ? 'Collapse' : 'Expand'}
                  aria-expanded={enumeratorQcExpanded}
                >
                  {enumeratorQcExpanded ? '−' : '+'}
                </button>
              </div>
              {enumeratorQcExpanded && (
                <>
                  <p className="text-[10px] text-slate-500 mb-3 leading-snug">
                    Your wards:{' '}
                    <span className="font-semibold text-slate-700">
                      {assignedWardsForFilter.length <= 2
                        ? assignedWardsForFilter.join(', ')
                        : `${assignedWardsForFilter.length} wards`}
                    </span>
                  </p>
                  <div className="space-y-3">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-slate-500">Verified</span>
                      <span className="font-bold text-green-600">{enumeratorTaskStats.verified}</span>
                    </div>
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-slate-500">Pending</span>
                      <span className="font-bold text-amber-600">{enumeratorTaskStats.pending}</span>
                    </div>
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-slate-500">Rejected</span>
                      <span className="font-bold text-red-600">{enumeratorTaskStats.rejected}</span>
                    </div>
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-slate-500">New Added</span>
                      <span className="font-bold text-violet-700">{enumeratorTaskStats.newAdded}</span>
                    </div>
                    <div className="flex justify-between items-center text-xs border-t border-slate-100 pt-2">
                      <span className="text-slate-500">Landmarks (assigned)</span>
                      <span className="font-bold text-slate-800">{enumeratorTaskStats.landmarkTotal}</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Add Hint Bar */}
      {isAddingFeature && (
        <div className="bg-blue-600 text-white text-center py-1 text-xs font-bold animate-pulse">
          MODE: CLICK ON MAP TO ADD {isAddingFeature.toUpperCase()}
        </div>
      )}
      {movingFeature && (
        <div className="bg-indigo-600 text-white text-center py-1.5 text-xs font-bold flex items-center justify-center gap-3">
          <span>
            MOVE MODE: Click map to set new location for {movingFeature.attributes?.name || 'selected landmark'}.
          </span>
          <button
            type="button"
            onClick={cancelMoveFeature}
            className="px-2 py-0.5 rounded bg-white/20 hover:bg-white/30"
          >
            Cancel
          </button>
        </div>
      )}
      {!movingFeature && lastMovedPoint && (
        <div className="bg-amber-600 text-white text-center py-1.5 text-xs font-bold flex items-center justify-center gap-3">
          <span>
            Point moved: {lastMovedPoint.featureName}
          </span>
          <button
            type="button"
            onClick={() => void undoLastMove()}
            className="px-2 py-0.5 rounded bg-white/20 hover:bg-white/30"
          >
            Undo Move
          </button>
          <button
            type="button"
            onClick={() => setLastMovedPoint(null)}
            className="px-2 py-0.5 rounded bg-white/20 hover:bg-white/30"
          >
            Dismiss
          </button>
        </div>
      )}
      {showBackExitWarning && (
        <div className="bg-rose-600 text-white text-center py-1.5 text-xs font-bold">
          Press back again within 4 seconds to leave this page.
        </div>
      )}
    </div>
  );
};

export default function App() {
  return (
    <AuthProvider>
      <GeoLocationProvider>
        <AppContent />
      </GeoLocationProvider>
    </AuthProvider>
  );
}
