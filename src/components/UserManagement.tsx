import React, { useMemo, useState, useEffect } from 'react';
import {
  UserPlus,
  X,
  Key,
  Mail,
  User as UserIcon,
  Shield,
  Check,
  Clock,
  Ban,
  ClipboardList,
  Phone,
  Search,
  MapPin,
  FileText,
  Folder
} from 'lucide-react';
import { fetchLandmarkGeoJson } from '../lib/landmarkGeoJson';
import { Project, Questionnaire, UserProfile } from '../types';
import { DEFAULT_PROJECT_ID } from '../lib/projects';
import { geosurveyApi } from '../lib/geosurveyApi';
import { zoneLayersApi } from '../lib/zoneLayersApi';
import { assignedZoneValuesFromProfile } from '../lib/assignedZones';

type EnumeratorEntry = {
  email: string;
  displayName: string;
  mobileNumber?: string;
  // One email can map to multiple Firebase Auth UIDs.
  uids: string[];
  /** Normalized list (legacy single ward folded in when loading). */
  assignedWardNames: string[];
  /** Zone attribute values from imported SHP assignment field. */
  assignedZoneValues: string[];
  /** Union of `assignedQuestionnaireIds` across all UIDs sharing this email. */
  assignedQuestionnaireIds: string[];
  /** Project IDs with explicit Geospatial Survey entitlement. */
  assignedGeospatialProjectIds: string[];
};

const normalizeUserSearch = (q: string) => q.trim().toLowerCase();

const enumeratorMatchesSearch = (e: EnumeratorEntry, q: string): boolean => {
  const n = normalizeUserSearch(q);
  if (!n) return true;
  const hay = [e.displayName, e.email, e.mobileNumber ?? '', e.uids.join(' ')].join(' ').toLowerCase();
  return hay.includes(n);
};

/** Admin-only: Firebase Auth UIDs (one line each if merged by email). */
const EnumeratorUidLines: React.FC<{ uids: string[] }> = ({ uids }) => {
  const list = uids.filter(Boolean);
  if (list.length === 0) return null;
  return (
    <div className="text-[9px] text-gray-400 font-mono leading-snug space-y-0.5 mt-0.5">
      {list.map((id, i) => (
        <p key={id} className="truncate" title={id}>
          {list.length > 1 ? `UID ${i + 1}: ` : 'UID: '}
          {id}
        </p>
      ))}
    </div>
  );
};

const pendingUserMatchesSearch = (u: UserProfile, q: string): boolean => {
  const n = normalizeUserSearch(q);
  if (!n) return true;
  const hay = [u.displayName ?? '', u.email ?? '', u.mobileNumber ?? '', u.uid ?? ''].join(' ').toLowerCase();
  return hay.includes(n);
};

const normalizeWardKey = (s: string) => s.trim().toLowerCase();
const parseWardNumber = (label: string): number | null => {
  const m = String(label).trim().match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
};

const wardsFromUserProfile = (data: UserProfile): string[] => {
  const list = data.assignedWardNames;
  if (Array.isArray(list) && list.length > 0) {
    return [...new Set(list.map((w) => String(w).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }
  const legacy = data.assignedWardName;
  if (typeof legacy === 'string' && legacy.trim()) return [legacy.trim()];
  return [];
};

const questionnaireIdsFromUserProfile = (data: UserProfile): string[] => {
  const list = data.assignedQuestionnaireIds;
  if (Array.isArray(list) && list.length > 0) {
    return [...new Set(list.map((w) => String(w).trim()).filter(Boolean))].sort();
  }
  return [];
};

/**
 * One card per enumerator for the active project. Shows only the survey
 * segments this project enables (geospatial / questionnaire), with a single
 * Save for the whole assignment.
 */
const EnumeratorProjectTaskRow: React.FC<{
  entry: EnumeratorEntry;
  enableGeospatial: boolean;
  enableQuestionnaire: boolean;
  wardOptions: string[];
  /** When set, geospatial assignment uses zone SHP attribute values. */
  zoneOptions?: string[];
  zoneFieldLabel?: string | null;
  questionnaires: Questionnaire[];
  saving: boolean;
  wardHeldByOther: Map<string, { displayName: string; email: string }>;
  /** Zone values already assigned to another enumerator (exclusive). */
  zoneHeldByOther?: Map<string, { displayName: string; email: string }>;
  onSave: (next: {
    wards?: string[];
    zoneValues?: string[];
    questionnaireIds?: string[];
  }) => void;
}> = ({
  entry,
  enableGeospatial,
  enableQuestionnaire,
  wardOptions,
  zoneOptions = [],
  zoneFieldLabel,
  questionnaires,
  saving,
  wardHeldByOther,
  zoneHeldByOther = new Map(),
  onSave
}) => {
  const projectQIds = useMemo(() => new Set(questionnaires.map((q) => q.id)), [questionnaires]);
  const initialQIds = useMemo(
    () => (entry.assignedQuestionnaireIds || []).filter((id) => projectQIds.has(id)),
    [entry.assignedQuestionnaireIds, projectQIds]
  );

  const [wards, setWards] = useState<string[]>(() => [...entry.assignedWardNames]);
  const [zoneValues, setZoneValues] = useState<string[]>(() => [...(entry.assignedZoneValues || [])]);
  const [questionnaireIds, setQuestionnaireIds] = useState<string[]>(initialQIds);

  useEffect(() => {
    setWards([...entry.assignedWardNames]);
  }, [entry.assignedWardNames, entry.email]);

  useEffect(() => {
    setZoneValues([...(entry.assignedZoneValues || [])]);
  }, [entry.assignedZoneValues, entry.email]);

  useEffect(() => {
    setQuestionnaireIds(initialQIds);
  }, [initialQIds]);

  const allQuestionnairesOn =
    questionnaires.length > 0 && questionnaireIds.length === questionnaires.length;
  const useZones = zoneOptions.length > 0;
  const geospatialOn = useZones ? zoneValues.length > 0 : wards.length > 0;
  const questionnaireOn = questionnaireIds.length > 0;

  const toggleWard = (w: string) => {
    setWards((prev) => {
      const key = normalizeWardKey(w);
      const has = prev.some((x) => normalizeWardKey(x) === key);
      if (has) return prev.filter((x) => normalizeWardKey(x) !== key);
      return [...prev, w].sort((a, b) => a.localeCompare(b));
    });
  };

  const toggleZone = (v: string) => {
    const key = normalizeWardKey(v);
    const held = zoneHeldByOther.get(key);
    // Cannot claim a zone already assigned to someone else.
    if (held) return;
    setZoneValues((prev) => {
      const has = prev.some((x) => normalizeWardKey(x) === key);
      if (has) return prev.filter((x) => normalizeWardKey(x) !== key);
      return [...prev, v].sort((a, b) => a.localeCompare(b));
    });
  };

  const toggleQuestionnaire = (id: string) => {
    setQuestionnaireIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const setFullQuestionnaire = (on: boolean) => {
    setQuestionnaireIds(on ? questionnaires.map((q) => q.id) : []);
  };

  const sameStringSet = (a: string[], b: string[]) => {
    if (a.length !== b.length) return false;
    const left = [...a].map((x) => normalizeWardKey(x)).sort();
    const right = [...b].map((x) => normalizeWardKey(x)).sort();
    return left.every((v, i) => v === right[i]);
  };

  const isDirty = (() => {
    if (enableGeospatial && useZones) {
      if (!sameStringSet(zoneValues, entry.assignedZoneValues || [])) return true;
    }
    if (enableQuestionnaire) {
      if (!sameStringSet(questionnaireIds, initialQIds)) return true;
    }
    return false;
  })();

  const handleSave = () => {
    if (!isDirty || saving) return;
    onSave({
      ...(enableGeospatial
        ? useZones
          ? { zoneValues, wards: [] }
          : { zoneValues: [], wards: [] }
        : {}),
      ...(enableQuestionnaire ? { questionnaireIds } : {})
    });
  };

  return (
    <div className="bg-gray-50 border border-gray-100 rounded-xl p-3 space-y-3">
      <div className="min-w-0">
        <p className="text-xs font-semibold text-gray-800 truncate">{entry.displayName}</p>
        <p className="text-[10px] text-gray-500 truncate">{entry.email}</p>
        <p className="text-[10px] text-gray-500 truncate">
          {entry.mobileNumber || 'No mobile number'}
        </p>
        <EnumeratorUidLines uids={entry.uids} />
        <div className="flex flex-wrap gap-1.5 mt-2">
          {enableGeospatial && (
            <span
              className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                geospatialOn
                  ? 'bg-blue-50 text-blue-700 border-blue-200'
                  : 'bg-white text-gray-400 border-gray-200'
              }`}
            >
              Geospatial {geospatialOn ? 'on' : 'off'}
            </span>
          )}
          {enableQuestionnaire && (
            <span
              className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                questionnaireOn
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : 'bg-white text-gray-400 border-gray-200'
              }`}
            >
              Questionnaire {questionnaireOn ? 'on' : 'off'}
            </span>
          )}
        </div>
      </div>

      {enableGeospatial && useZones && (
        <div className="space-y-2 pt-2 border-t border-gray-200">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <MapPin size={13} className="text-sky-600 shrink-0" />
              <label className="text-[10px] font-bold text-sky-700 uppercase tracking-wider">
                Boundary assignment{zoneFieldLabel ? ` · ${zoneFieldLabel}` : ''}
              </label>
            </div>
            <button
              type="button"
              disabled={saving || zoneValues.length === 0}
              onClick={() => setZoneValues([])}
              className="text-[10px] font-semibold text-gray-500 hover:text-gray-800 disabled:opacity-40"
            >
              Clear boundaries
            </button>
          </div>
          <p className="text-[10px] text-gray-500 leading-relaxed">
            Each boundary value can be assigned to only one enumerator. Values already taken by
            someone else are locked until cleared from their assignment.
          </p>
          <div className="max-h-40 overflow-y-auto border border-gray-200 rounded-lg p-2 space-y-1.5 bg-white">
            {zoneOptions.map((v) => {
              const mine = zoneValues.some((x) => normalizeWardKey(x) === normalizeWardKey(v));
              const held = zoneHeldByOther.get(normalizeWardKey(v));
              const locked = Boolean(held) && !mine;
              return (
                <label
                  key={v}
                  className={`flex items-start gap-2 text-xs select-none ${
                    locked ? 'opacity-55 cursor-not-allowed' : 'cursor-pointer'
                  }`}
                  title={
                    locked
                      ? `Already assigned to ${held!.displayName} (${held!.email})`
                      : undefined
                  }
                >
                  <input
                    type="checkbox"
                    checked={mine}
                    onChange={() => toggleZone(v)}
                    disabled={saving || locked}
                    className="rounded border-gray-300 text-sky-600 focus:ring-sky-500 mt-0.5 shrink-0"
                  />
                  <span className="min-w-0 flex-1">
                    <span className={`truncate block ${locked ? 'text-gray-400' : 'text-gray-800'}`}>
                      {v}
                    </span>
                    {locked && (
                      <span className="block text-[9px] text-rose-600 mt-0.5 truncate">
                        Taken by {held!.displayName}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
          <p className="text-[10px] text-gray-500">
            {zoneValues.length === 0
              ? 'No boundaries assigned.'
              : `${zoneValues.length} boundary zone(s) assigned.`}
          </p>
        </div>
      )}

      {enableGeospatial && !useZones && (
        <div className="space-y-2 pt-2 border-t border-gray-200">
          <div className="flex items-center gap-1.5 min-w-0">
            <MapPin size={13} className="text-amber-600 shrink-0" />
            <label className="text-[10px] font-bold text-amber-700 uppercase tracking-wider">
              Geospatial survey
            </label>
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 leading-relaxed">
            Import a zone boundary SHP (ZIP) from <strong>Geospatial Assignment → Manage SHP</strong> first.
            Then assign enumerators by any attribute field from that shapefile.
          </div>
        </div>
      )}

      {enableQuestionnaire && (
        <div className="space-y-3 pt-2 border-t border-gray-200">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <ClipboardList size={13} className="text-emerald-600 shrink-0" />
              <label className="text-[10px] font-bold text-emerald-700 uppercase tracking-wider">
                Questionnaire survey
              </label>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={saving || questionnaires.length === 0 || allQuestionnairesOn}
                onClick={() => setFullQuestionnaire(true)}
                className="text-[10px] font-semibold text-emerald-700 hover:text-emerald-900 disabled:opacity-40"
              >
                Assign full
              </button>
              <button
                type="button"
                disabled={saving || questionnaireIds.length === 0}
                onClick={() => setFullQuestionnaire(false)}
                className="text-[10px] font-semibold text-gray-500 hover:text-gray-800 disabled:opacity-40"
              >
                Clear
              </button>
            </div>
          </div>
          <p className="text-[10px] text-gray-500 leading-relaxed">
            Assign the full questionnaire survey for this project (all forms below), or pick
            individual forms.
          </p>

          <label
            className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs cursor-pointer select-none ${
              allQuestionnairesOn
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-white border-gray-200 text-gray-700'
            }`}
          >
            <input
              type="checkbox"
              checked={allQuestionnairesOn}
              disabled={saving || questionnaires.length === 0}
              onChange={(e) => setFullQuestionnaire(e.target.checked)}
              className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 shrink-0"
            />
            <span className="font-semibold">
              Full questionnaire survey
              {questionnaires.length > 0 ? ` (${questionnaires.length})` : ''}
            </span>
          </label>

          <div className="max-h-40 overflow-y-auto border border-gray-200 rounded-lg p-2 space-y-1.5 bg-white">
            {questionnaires.length === 0 ? (
              <p className="text-[11px] text-gray-400 italic">No questionnaires in this project.</p>
            ) : (
              questionnaires.map((q) => {
                const checked = questionnaireIds.includes(q.id);
                const inactive = q.isActive === false;
                return (
                  <label
                    key={q.id}
                    className="flex items-start gap-2 text-xs select-none cursor-pointer"
                    title={inactive ? 'Draft / inactive questionnaire' : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={saving}
                      onChange={() => toggleQuestionnaire(q.id)}
                      className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 mt-0.5 shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <FileText size={11} className="text-emerald-600 shrink-0" />
                        <span className="block truncate text-gray-800">
                          {q.title || '(untitled)'}
                        </span>
                        {inactive && (
                          <span className="text-[9px] uppercase tracking-wider font-bold bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded">
                            Draft
                          </span>
                        )}
                      </span>
                      {q.version && (
                        <span className="block text-[10px] text-gray-400 mt-0.5">v{q.version}</span>
                      )}
                    </span>
                  </label>
                );
              })
            )}
          </div>
        </div>
      )}

      {(enableGeospatial && useZones) || enableQuestionnaire ? (
        <button
          type="button"
          disabled={saving || !isDirty}
          onClick={handleSave}
          className="w-full text-xs font-bold py-2.5 rounded-lg bg-slate-800 text-white hover:bg-slate-900 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? 'Saving…' : isDirty ? 'Save project assignment' : 'No changes to save'}
        </button>
      ) : null}
    </div>
  );
};

export type UserManagementTab = 'pending' | 'boundary' | 'geospatial' | 'questionnaire' | 'create';

export const UserManagement: React.FC<{
  /**
   * Active project context. When provided:
   *  - Geospatial Assignment assigns imported SHP values,
   *  - Questionnaire Assignment assigns published project forms,
   *  - questionnaire saves apply only to this project (other projects are
   *    preserved).
   */
  project?: Project | null;
  initialTab?: UserManagementTab;
  onClose: () => void;
}> = ({ project, initialTab = 'pending', onClose }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingUsers, setPendingUsers] = useState<UserProfile[]>([]);
  const [activeTab, setActiveTab] = useState<UserManagementTab>(initialTab);
  const segmentGeo = project ? project.segments?.geospatial === true : false;
  const segmentQ = project ? project.segments?.questionnaire !== false : true;

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  // Project's questionnaires — drives the Questionnaire Assignment tab.
  const [projectQuestionnaires, setProjectQuestionnaires] = useState<Questionnaire[]>([]);

  const [activeEnumeratorsCount, setActiveEnumeratorsCount] = useState(0);
  const [activeEnumerators, setActiveEnumerators] = useState<EnumeratorEntry[]>([]);
  const [deactivatedEnumeratorsCount, setDeactivatedEnumeratorsCount] = useState(0);
  const [deactivatedEnumerators, setDeactivatedEnumerators] = useState<EnumeratorEntry[]>([]);
  const [totalEnumeratorsCount, setTotalEnumeratorsCount] = useState(0);
  const [landmarkWardOptions, setLandmarkWardOptions] = useState<string[]>([]);
  const [zoneAssignOptions, setZoneAssignOptions] = useState<string[]>([]);
  const [zoneAssignField, setZoneAssignField] = useState<string | null>(null);
  const [zoneLayerId, setZoneLayerId] = useState<string | null>(null);

  const [enumActionLoadingEmail, setEnumActionLoadingEmail] = useState<string | null>(null);
  const [taskSavingEmail, setTaskSavingEmail] = useState<string | null>(null);
  const [clearingAllAssignments, setClearingAllAssignments] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);
  const [manageTabSearch, setManageTabSearch] = useState('');
  const [tasksTabSearch, setTasksTabSearch] = useState('');

  const loadUsers = async () => {
    const { items } = await geosurveyApi.listUsers();
    return items as UserProfile[];
  };

  const wardNameOptions = useMemo(
    () =>
      [...landmarkWardOptions].sort((a, b) => {
        const an = parseWardNumber(a);
        const bn = parseWardNumber(b);
        if (an !== null && bn !== null) return an - bn;
        if (an !== null) return -1;
        if (bn !== null) return 1;
        return a.localeCompare(b);
      }),
    [landmarkWardOptions]
  );

  /** For each enumerator row: wards already assigned to someone else (normalized ward key -> holder). */
  const wardLocksByEnumeratorEmail = useMemo(() => {
    const result = new Map<string, Map<string, { displayName: string; email: string }>>();
    for (const target of activeEnumerators) {
      const myKey = target.email.trim().toLowerCase();
      const m = new Map<string, { displayName: string; email: string }>();
      for (const e of activeEnumerators) {
        if (e.email.trim().toLowerCase() === myKey) continue;
        for (const w of e.assignedWardNames) {
          m.set(normalizeWardKey(w), { displayName: e.displayName, email: e.email });
        }
      }
      result.set(target.email, m);
    }
    return result;
  }, [activeEnumerators]);

  /** For each enumerator: zone values already assigned to someone else (exclusive). */
  const zoneLocksByEnumeratorEmail = useMemo(() => {
    const result = new Map<string, Map<string, { displayName: string; email: string }>>();
    for (const target of activeEnumerators) {
      const myKey = target.email.trim().toLowerCase();
      const m = new Map<string, { displayName: string; email: string }>();
      for (const e of activeEnumerators) {
        if (e.email.trim().toLowerCase() === myKey) continue;
        for (const z of e.assignedZoneValues || []) {
          m.set(normalizeWardKey(z), { displayName: e.displayName, email: e.email });
        }
      }
      result.set(target.email, m);
    }
    return result;
  }, [activeEnumerators]);

  /** Same ward given to more than one enumerator (legacy or race) — admin should fix. */
  const duplicateWardAssignments = useMemo(() => {
    const keyToOwners = new Map<string, Set<string>>();
    const keyToLabel = new Map<string, string>();
    for (const e of activeEnumerators) {
      const nameLabel = (e.displayName || '').trim() || e.email;
      for (const w of e.assignedWardNames) {
        const nk = normalizeWardKey(w);
        keyToLabel.set(nk, w);
        const set = keyToOwners.get(nk) ?? new Set<string>();
        set.add(nameLabel);
        keyToOwners.set(nk, set);
      }
    }
    const dups: { wardLabel: string; owners: string[] }[] = [];
    for (const [nk, set] of keyToOwners) {
      if (set.size > 1) {
        dups.push({ wardLabel: keyToLabel.get(nk) ?? nk, owners: [...set] });
      }
    }
    return dups;
  }, [activeEnumerators]);

  /** Same zone value held by more than one enumerator — admin should fix. */
  const duplicateZoneAssignments = useMemo(() => {
    const keyToOwners = new Map<string, Set<string>>();
    const keyToLabel = new Map<string, string>();
    for (const e of activeEnumerators) {
      const nameLabel = (e.displayName || '').trim() || e.email;
      for (const z of e.assignedZoneValues || []) {
        const nk = normalizeWardKey(z);
        keyToLabel.set(nk, z);
        const set = keyToOwners.get(nk) ?? new Set<string>();
        set.add(nameLabel);
        keyToOwners.set(nk, set);
      }
    }
    const dups: { zoneLabel: string; owners: string[] }[] = [];
    for (const [nk, set] of keyToOwners) {
      if (set.size > 1) {
        dups.push({ zoneLabel: keyToLabel.get(nk) ?? nk, owners: [...set] });
      }
    }
    return dups;
  }, [activeEnumerators]);

  const filteredActiveForManage = useMemo(
    () =>
      manageTabSearch.trim()
        ? activeEnumerators.filter((e) => enumeratorMatchesSearch(e, manageTabSearch))
        : activeEnumerators,
    [activeEnumerators, manageTabSearch]
  );

  const filteredDeactivatedForManage = useMemo(
    () =>
      manageTabSearch.trim()
        ? deactivatedEnumerators.filter((e) => enumeratorMatchesSearch(e, manageTabSearch))
        : deactivatedEnumerators,
    [deactivatedEnumerators, manageTabSearch]
  );

  const filteredPendingForManage = useMemo(
    () =>
      manageTabSearch.trim()
        ? pendingUsers.filter((u) => pendingUserMatchesSearch(u, manageTabSearch))
        : pendingUsers,
    [pendingUsers, manageTabSearch]
  );

  const filteredEnumeratorsForTasks = useMemo(
    () =>
      tasksTabSearch.trim()
        ? activeEnumerators.filter((e) => enumeratorMatchesSearch(e, tasksTabSearch))
        : activeEnumerators,
    [activeEnumerators, tasksTabSearch]
  );

  const refreshAll = async () => {
    try {
      const [allUsersResult, questionnairesResult] = await Promise.all([
        loadUsers(),
        geosurveyApi.listQuestionnaires()
      ]);
      const allUsers = allUsersResult
        .filter((data) => !data.role || data.role === 'enumerator')
        .map((data) => ({
          ...data,
          role: data.role || 'enumerator',
          status: data.status || 'pending'
        }));

      setPendingUsers(allUsers.filter((u) => u.status === 'pending'));

      const targetProjectId = project?.id;
      if (!targetProjectId) {
        setProjectQuestionnaires([]);
      } else {
        const qList = (questionnairesResult.items as unknown as Questionnaire[])
          .filter((it) => {
            const pid = it.projectId || DEFAULT_PROJECT_ID;
            return pid === targetProjectId;
          })
          .sort((a, b) => (a.title || '').localeCompare(b.title || ''));
        setProjectQuestionnaires(qList);
      }

      const buildEntries = (status: 'approved' | 'rejected') => {
        const byEmail = new Map<string, EnumeratorEntry>();
        for (const data of allUsers) {
          if (data.role !== 'enumerator' || data.status !== status) continue;
          const emailKey = (data.email || '').trim().toLowerCase();
          if (!emailKey) continue;
          const uid = data.uid;
          const existing = byEmail.get(emailKey);
          const wn = wardsFromUserProfile(data);
          const zv = assignedZoneValuesFromProfile(data, targetProjectId);
          const qids = questionnaireIdsFromUserProfile(data);
          const geoIds = data.assignedGeospatialProjectIds || [];
          if (!existing) {
            byEmail.set(emailKey, {
              email: data.email,
              displayName: data.displayName,
              mobileNumber: data.mobileNumber,
              uids: uid ? [uid] : [],
              assignedWardNames: status === 'approved' ? wn : [],
              assignedZoneValues: status === 'approved' ? zv : [],
              assignedQuestionnaireIds: status === 'approved' ? qids : [],
              assignedGeospatialProjectIds: status === 'approved' ? geoIds : []
            });
            continue;
          }
          if (uid && !existing.uids.includes(uid)) existing.uids.push(uid);
          if (!existing.mobileNumber && data.mobileNumber) existing.mobileNumber = data.mobileNumber;
          if (status === 'approved') {
            existing.assignedWardNames = [...new Set([...existing.assignedWardNames, ...wn])].sort((a, b) => a.localeCompare(b));
            existing.assignedZoneValues = [...new Set([...existing.assignedZoneValues, ...zv])].sort((a, b) => a.localeCompare(b));
            existing.assignedQuestionnaireIds = [...new Set([...existing.assignedQuestionnaireIds, ...qids])].sort();
            existing.assignedGeospatialProjectIds = [...new Set([...existing.assignedGeospatialProjectIds, ...geoIds])];
          }
        }
        return Array.from(byEmail.values()).sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
      };

      const approvedEntries = buildEntries('approved');
      const rejectedEntries = buildEntries('rejected');
      setActiveEnumerators(approvedEntries);
      setActiveEnumeratorsCount(approvedEntries.length);
      setDeactivatedEnumerators(rejectedEntries);
      setDeactivatedEnumeratorsCount(rejectedEntries.length);
      setError(null);
    } catch (error) {
      console.error('Error loading user management data:', error);
      setError(error instanceof Error ? error.message : 'Failed to load user data');
    }
  };

  useEffect(() => {
    void refreshAll();
  }, [project?.id]);

  useEffect(() => {
    let mounted = true;
    const loadWardOptionsFromLandmarks = async () => {
      try {
        const resp = await fetchLandmarkGeoJson();
        if (!resp.ok) return;
        const geo = await resp.json();
        const rows = Array.isArray(geo?.features) ? geo.features : [];
        const wards = rows
          .map((f: any) => f?.properties?.Ward_Name ?? f?.properties?.WARDNAME ?? f?.properties?.WardName)
          .map((v: unknown) => String(v ?? '').trim())
          .filter(Boolean);
        if (!mounted) return;
        setLandmarkWardOptions([...new Set(wards)]);
      } catch {
        if (!mounted) return;
        setLandmarkWardOptions([]);
      }
    };

    loadWardOptionsFromLandmarks();
    return () => {
      mounted = false;
    };
  }, []);

  // Zone SHP assignment values for this project (generic attribute field).
  useEffect(() => {
    let mounted = true;
    const loadZoneAssignOptions = async () => {
      if (!project?.id || !segmentGeo) {
        setZoneAssignOptions([]);
        setZoneAssignField(null);
        setZoneLayerId(null);
        return;
      }
      try {
        const { items } = await zoneLayersApi.listLayers(project.id);
        const layer = items[0] || null;
        if (!mounted) return;
        if (!layer) {
          setZoneAssignOptions([]);
          setZoneAssignField(null);
          setZoneLayerId(null);
          return;
        }
        setZoneLayerId(layer.id);
        setZoneAssignField(layer.assignmentField || null);
        const { values } = await zoneLayersApi.listAssignValues(layer.id);
        if (!mounted) return;
        setZoneAssignOptions(values);
      } catch (e) {
        console.warn('Failed to load zone assign options', e);
        if (!mounted) return;
        setZoneAssignOptions([]);
        setZoneAssignField(null);
        setZoneLayerId(null);
      }
    };
    void loadZoneAssignOptions();
    return () => {
      mounted = false;
    };
  }, [project?.id, segmentGeo]);

  useEffect(() => {
    setTotalEnumeratorsCount(pendingUsers.length + activeEnumeratorsCount + deactivatedEnumeratorsCount);
  }, [pendingUsers.length, activeEnumeratorsCount, deactivatedEnumeratorsCount]);

  const handleApproveUser = async (userId: string) => {
    try {
      await geosurveyApi.updateUser(userId, { status: 'approved' });
      await refreshAll();
    } catch (error) {
      console.error('Error approving user:', error);
      setError('Failed to approve user');
    }
  };

  const handleRejectUser = async (userId: string) => {
    try {
      await geosurveyApi.updateUser(userId, { status: 'rejected' });
      await refreshAll();
    } catch (error) {
      console.error('Error rejecting user:', error);
      setError('Failed to reject user');
    }
  };

  const setEnumeratorStatusByEntry = async (entry: EnumeratorEntry, status: 'approved' | 'rejected') => {
    try {
      setEnumActionLoadingEmail(entry.email);
      setError(null);

      await Promise.all(entry.uids.map((uid) => geosurveyApi.updateUser(uid, { status })));
      await refreshAll();
    } catch (e) {
      console.error('Error updating enumerator status:', e);
      setError(`Failed to update enumerator (${status})`);
    } finally {
      setEnumActionLoadingEmail(null);
    }
  };

  const permanentlyDeleteEnumerator = async (entry: EnumeratorEntry) => {
    try {
      setEnumActionLoadingEmail(entry.email);
      setError(null);
      setDeleteNotice(null);

      await Promise.all(entry.uids.map((uid) => geosurveyApi.deleteUser(uid)));
      await refreshAll();

      setDeleteNotice(
          `Deleted ${entry.displayName}.`
      );
    } catch (e) {
      console.error('Error permanently deleting enumerator:', e);
      setError('Failed to permanently delete enumerator from Firestore');
    } finally {
      setEnumActionLoadingEmail(null);
    }
  };

  const saveEnumeratorProjectAssignment = async (
    entry: EnumeratorEntry,
    next: { wards?: string[]; zoneValues?: string[]; questionnaireIds?: string[] }
  ) => {
    try {
      setTaskSavingEmail(entry.email);
      setError(null);

      const patch: Partial<UserProfile> = {};
      const projectId = project?.id;

      if (next.wards !== undefined) {
        const normalized = [...new Set(next.wards.map((w) => String(w).trim()).filter(Boolean))].sort(
          (a, b) => a.localeCompare(b)
        );
        const myKey = entry.email.trim().toLowerCase();
        for (const w of normalized) {
          const wk = normalizeWardKey(w);
          const conflict = activeEnumerators.find(
            (e) =>
              e.email.trim().toLowerCase() !== myKey &&
              e.assignedWardNames.some((x) => normalizeWardKey(x) === wk)
          );
          if (conflict) {
            setError(
              `Cannot save: "${w}" is already assigned to ${conflict.displayName}. Remove it from that enumerator first.`
            );
            setTaskSavingEmail(null);
            return;
          }
        }
        patch.assignedWardNames = normalized.length ? normalized : [];
        patch.assignedWardName = null;
      }

      if (next.zoneValues !== undefined) {
        const normalized = [
          ...new Set(next.zoneValues.map((v) => String(v).trim()).filter(Boolean))
        ].sort((a, b) => a.localeCompare(b));
        const myKey = entry.email.trim().toLowerCase();
        for (const z of normalized) {
          const zk = normalizeWardKey(z);
          const conflict = activeEnumerators.find(
            (e) =>
              e.email.trim().toLowerCase() !== myKey &&
              (e.assignedZoneValues || []).some((x) => normalizeWardKey(x) === zk)
          );
          if (conflict) {
            setError(
              `Cannot save: "${z}" is already assigned to ${conflict.displayName}. Remove it from that enumerator first.`
            );
            setTaskSavingEmail(null);
            return;
          }
        }
        patch.assignedZoneValues = normalized;
        patch.assignedZoneLayerId = normalized.length && zoneLayerId ? zoneLayerId : null;
      }

      if (next.questionnaireIds !== undefined) {
        const projectQIds = new Set(projectQuestionnaires.map((q) => q.id));
        const preserved = (entry.assignedQuestionnaireIds || []).filter(
          (id) => !projectQIds.has(id)
        );
        patch.assignedQuestionnaireIds = [...new Set([...preserved, ...next.questionnaireIds])].sort();
      }

      if (Object.keys(patch).length === 0) {
        setTaskSavingEmail(null);
        return;
      }

      // Merge per-project zone map so other projects are preserved.
      if (next.zoneValues !== undefined && projectId) {
        const allUsers = await loadUsers();
        await Promise.all(
          entry.uids.map(async (uid) => {
            const profile = allUsers.find((u) => u.uid === uid);
            const existingMap = { ...(profile?.projectZoneAssignments || {}) };
            const values = patch.assignedZoneValues || [];
            if (values.length) existingMap[projectId] = values;
            else delete existingMap[projectId];
            await geosurveyApi.updateUser(uid, {
              ...patch,
              projectZoneAssignments: existingMap,
            });
          })
        );
      } else {
        await Promise.all(entry.uids.map((uid) => geosurveyApi.updateUser(uid, patch)));
      }
      await refreshAll();
    } catch (e) {
      console.error('Error saving project assignment:', e);
      setError('Failed to save project assignment');
    } finally {
      setTaskSavingEmail(null);
    }
  };

  const clearAllEnumeratorQuestionnaireAssignmentsForProject = async () => {
    if (activeEnumerators.length === 0 || projectQuestionnaires.length === 0) return;
    if (
      !confirm(
        `Clear questionnaire assignments for ALL active enumerators in this project?\n\n` +
          `Assignments for questionnaires in other projects are preserved.`
      )
    )
      return;

    try {
      setClearingAllAssignments(true);
      setError(null);
      const projectQIds = new Set(projectQuestionnaires.map((q) => q.id));
      await Promise.all(
        activeEnumerators.flatMap((entry) => {
          const preserved = (entry.assignedQuestionnaireIds || []).filter(
            (id) => !projectQIds.has(id)
          );
          return entry.uids.map((uid) =>
            geosurveyApi.updateUser(uid, { assignedQuestionnaireIds: preserved } as Partial<UserProfile>)
          );
        })
      );
      await refreshAll();
    } catch (e) {
      console.error('Error clearing project questionnaire assignments:', e);
      setError('Failed to clear questionnaire assignments');
    } finally {
      setClearingAllAssignments(false);
    }
  };

  const clearAllEnumeratorWardAssignments = async () => {
    if (activeEnumerators.length === 0) return;

    try {
      setClearingAllAssignments(true);
      setError(null);

      const allUids = Array.from(
        new Set(activeEnumerators.flatMap((entry) => entry.uids))
      ) as string[];
      const projectId = project?.id;
      const allUsers = projectId ? await loadUsers() : [];
      await Promise.all(
        allUids.map((uid) => {
          const profile = allUsers.find((u) => u.uid === uid);
          const existingMap = { ...(profile?.projectZoneAssignments || {}) };
          if (projectId) delete existingMap[projectId];
          return geosurveyApi.updateUser(uid, {
            assignedWardNames: [],
            assignedWardName: null,
            assignedZoneValues: [],
            assignedZoneLayerId: null,
            ...(projectId ? { projectZoneAssignments: existingMap } : {}),
          } as Partial<UserProfile>);
        })
      );
      await refreshAll();
    } catch (e) {
      console.error('Error clearing all ward assignments:', e);
      setError('Failed to clear all geospatial assignments');
    } finally {
      setClearingAllAssignments(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    
    try {
      await geosurveyApi.createEnumerator({
        email,
        password,
        displayName: name,
        mobileNumber
      });
      await refreshAll();
      setSuccess(true);
      setEmail('');
      setPassword('');
      setName('');
      setMobileNumber('');
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to create user');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-white shadow-2xl border-l border-gray-200 w-full md:w-96">
      <div className="border-b border-gray-100 bg-gray-50/50 pt-[calc(env(safe-area-inset-top,0px)+1rem)] px-4 pb-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold text-gray-800 flex items-center gap-2">
            <UserPlus size={20} className="text-blue-600" />
            User Management
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-200 rounded-full transition-colors">
            <X size={20} className="text-gray-500" />
          </button>
        </div>
        {project && (
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-gray-500">
            <Folder size={12} className="text-blue-500 shrink-0" />
            <span className="truncate" title={project.name}>
              {project.name}
            </span>
            {project.code && <span className="text-gray-400">· {project.code}</span>}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-100 overflow-x-auto">
        <button
          type="button"
          onClick={() => setActiveTab('pending')}
          className={`shrink-0 py-2.5 px-3 text-[11px] font-medium transition-colors flex items-center justify-center gap-1.5 ${
            activeTab === 'pending' ? 'bg-blue-50 text-blue-600 border-b-2 border-blue-600' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Manage
          {pendingUsers.length > 0 && (
            <span className="min-w-[1.125rem] h-[1.125rem] px-1 rounded-full bg-amber-500 text-white text-[10px] font-bold leading-none flex items-center justify-center">
              {pendingUsers.length}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('boundary')}
          disabled={!segmentGeo}
          className={`shrink-0 py-2.5 px-3 text-[11px] font-medium transition-colors flex items-center justify-center gap-1 ${
            activeTab === 'boundary'
              ? 'bg-cyan-50 text-cyan-700 border-b-2 border-cyan-600'
              : 'text-gray-500 hover:text-gray-700 disabled:opacity-40'
          }`}
          title="Assign SHP zone boundaries to enumerators"
        >
          <MapPin size={13} className="shrink-0 hidden sm:block" />
          Boundary
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('geospatial')}
          disabled={!segmentGeo}
          className={`shrink-0 py-2.5 px-3 text-[11px] font-medium transition-colors flex items-center justify-center gap-1 ${
            activeTab === 'geospatial'
              ? 'bg-sky-50 text-sky-700 border-b-2 border-sky-600'
              : 'text-gray-500 hover:text-gray-700 disabled:opacity-40'
          }`}
          title="Enable/disable Geospatial Survey per enumerator"
        >
          Geo survey
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('questionnaire')}
          disabled={!segmentQ}
          className={`shrink-0 py-2.5 px-3 text-[11px] font-medium transition-colors flex items-center justify-center gap-1 ${
            activeTab === 'questionnaire'
              ? 'bg-emerald-50 text-emerald-700 border-b-2 border-emerald-600'
              : 'text-gray-500 hover:text-gray-700 disabled:opacity-40'
          }`}
          title="Assign project questionnaires"
        >
          <ClipboardList size={13} className="shrink-0 hidden sm:block" />
          Qsn assign
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('create')}
          className={`shrink-0 py-2.5 px-3 text-[11px] font-medium transition-colors ${
            activeTab === 'create' ? 'bg-blue-50 text-blue-600 border-b-2 border-blue-600' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Create
        </button>
      </div>

      <div className="p-6 space-y-6 flex-1 overflow-y-auto">
        {activeTab !== 'create' && (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-500 font-medium">Total Enumerators</span>
            <span className="text-blue-700 font-bold">{totalEnumeratorsCount}</span>
          </div>
          <div className="text-[11px] text-gray-500">
            Pending approval: {pendingUsers.length} • Active: {activeEnumeratorsCount} • Deactivated:{' '}
            {deactivatedEnumeratorsCount}
          </div>
        </div>
        )}

        {activeTab === 'pending' && (
          <>
        {error && (
          <div className="bg-red-50 text-red-600 p-3 rounded-xl text-xs border border-red-100">{error}</div>
        )}
        {deleteNotice && (
          <div className="bg-amber-50 text-amber-800 p-3 rounded-xl text-xs border border-amber-100">
            {deleteNotice}
          </div>
        )}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="search"
            value={manageTabSearch}
            onChange={(e) => setManageTabSearch(e.target.value)}
            placeholder="Search users (name, email, mobile, UID)…"
            className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-9 pr-3 text-sm text-gray-800 placeholder:text-gray-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            aria-label="Search enumerators"
          />
        </div>

        <div className="bg-amber-50/80 border border-amber-200 rounded-xl p-4">
          <h3 className="text-sm font-bold text-amber-900 mb-3">
            Pending Enumerator Sign-ups ({filteredPendingForManage.length}
            {manageTabSearch.trim() && pendingUsers.length > 0 ? ` / ${pendingUsers.length}` : ''})
          </h3>
          {pendingUsers.length === 0 ? (
            <p className="text-amber-900/70 text-sm">
              No pending sign-ups. New registrations appear here for approval.
            </p>
          ) : filteredPendingForManage.length === 0 ? (
            <p className="text-amber-900/70 text-sm">No users match your search.</p>
          ) : (
            <div className="space-y-3 max-h-80 overflow-y-auto overscroll-contain pr-1">
              {filteredPendingForManage.map((user) => (
                <div key={user.uid} className="bg-white p-4 rounded-xl border border-amber-100 shadow-sm">
                  <div className="flex items-center justify-between mb-3 gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-gray-800 truncate">{user.displayName}</p>
                      <p className="text-xs text-gray-500 truncate">{user.email}</p>
                      <p className="text-xs text-gray-500 truncate">
                        {user.mobileNumber || 'No mobile number'}
                      </p>
                      <EnumeratorUidLines uids={user.uid ? [user.uid] : []} />
                    </div>
                    <div className="flex items-center gap-1 text-amber-600 shrink-0">
                      <Clock size={14} />
                      <span className="text-xs font-medium">Pending</span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => void handleApproveUser(user.uid)}
                      className="flex-1 bg-green-600 text-white text-xs font-bold py-2 rounded-lg hover:bg-green-700 transition-colors flex items-center justify-center gap-1"
                    >
                      <Check size={14} /> Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleRejectUser(user.uid)}
                      className="flex-1 bg-red-600 text-white text-xs font-bold py-2 rounded-lg hover:bg-red-700 transition-colors flex items-center justify-center gap-1"
                    >
                      <Ban size={14} /> Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-gray-50 border border-gray-100 rounded-xl p-4">
          <h3 className="text-xs font-bold text-gray-700 mb-3">
            Active Enumerators ({filteredActiveForManage.length}
            {manageTabSearch.trim() ? ` / ${activeEnumeratorsCount}` : ''})
          </h3>

          {activeEnumerators.length === 0 ? (
            <p className="text-[11px] text-gray-400">No approved enumerators yet.</p>
          ) : filteredActiveForManage.length === 0 ? (
            <p className="text-[11px] text-gray-500">No users match your search.</p>
          ) : (
            <div className="max-h-72 overflow-y-auto overscroll-contain space-y-2 pr-1">
              {filteredActiveForManage.map((u) => (
                <div key={u.email} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-gray-700 truncate">
                      {u.displayName}
                    </p>
                    <p className="text-[10px] text-gray-500 truncate">{u.email}</p>
                    <p className="text-[10px] text-gray-500 truncate">{u.mobileNumber || 'No mobile number'}</p>
                    <EnumeratorUidLines uids={u.uids} />
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => {
                        const ok = confirm(`Deactivate "${u.displayName}"?`);
                        if (!ok) return;
                        void setEnumeratorStatusByEntry(u, 'rejected');
                      }}
                      disabled={enumActionLoadingEmail === u.email}
                      className="text-[10px] px-2 py-1 rounded-lg bg-red-50 text-red-700 hover:bg-red-100 transition-colors border border-red-100 disabled:opacity-50"
                      title="Deactivate enumerator"
                    >
                      Deactivate
                    </button>
                    <button
                      onClick={() => {
                        const ok = confirm(
                          `Permanently delete "${u.displayName}"?\n\nThis removes Firestore user record(s).`
                        );
                        if (!ok) return;
                        void permanentlyDeleteEnumerator(u);
                      }}
                      disabled={enumActionLoadingEmail === u.email}
                      className="text-[10px] px-2 py-1 rounded-lg bg-red-100 text-red-800 hover:bg-red-200 transition-colors border border-red-200 disabled:opacity-50"
                      title="Delete enumerator record permanently"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white border border-gray-100 rounded-xl p-4">
          <h3 className="text-xs font-bold text-gray-700 mb-3">
            Deactivated Enumerators ({filteredDeactivatedForManage.length}
            {manageTabSearch.trim() ? ` / ${deactivatedEnumeratorsCount}` : ''})
          </h3>

          {deactivatedEnumerators.length === 0 ? (
            <p className="text-[11px] text-gray-400">No deactivated enumerators yet.</p>
          ) : filteredDeactivatedForManage.length === 0 ? (
            <p className="text-[11px] text-gray-500">No users match your search.</p>
          ) : (
            <div className="max-h-72 overflow-y-auto overscroll-contain space-y-2 pr-1">
              {filteredDeactivatedForManage.map((u) => (
                <div key={u.email} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-gray-700 truncate">
                      {u.displayName}
                    </p>
                    <p className="text-[10px] text-gray-500 truncate">{u.email}</p>
                    <p className="text-[10px] text-gray-500 truncate">{u.mobileNumber || 'No mobile number'}</p>
                    <EnumeratorUidLines uids={u.uids} />
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => {
                        const ok = confirm(`Activate "${u.displayName}"?`);
                        if (!ok) return;
                        void setEnumeratorStatusByEntry(u, 'approved');
                      }}
                      disabled={enumActionLoadingEmail === u.email}
                      className="text-[10px] px-2 py-1 rounded-lg bg-green-50 text-green-700 hover:bg-green-100 transition-colors border border-green-100 disabled:opacity-50"
                      title="Activate enumerator"
                    >
                      Activate
                    </button>
                    <button
                      onClick={() => {
                        const ok = confirm(
                          `Permanently delete "${u.displayName}"?\n\nThis removes Firestore user record(s).`
                        );
                        if (!ok) return;
                        void permanentlyDeleteEnumerator(u);
                      }}
                      disabled={enumActionLoadingEmail === u.email}
                      className="text-[10px] px-2 py-1 rounded-lg bg-red-100 text-red-800 hover:bg-red-200 transition-colors border border-red-200 disabled:opacity-50"
                      title="Delete enumerator record permanently"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
          </>
        )}

        {(activeTab === 'boundary' || activeTab === 'geospatial' || activeTab === 'questionnaire') && (
          <div className="space-y-4">
            {error && (
              <div className="bg-red-50 text-red-600 p-3 rounded-xl text-xs border border-red-100">{error}</div>
            )}
            {project && (
              <div className="bg-blue-50/60 border border-blue-100 rounded-xl px-3 py-2 flex items-start gap-2">
                <Folder size={14} className="text-blue-600 mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-semibold text-blue-900 truncate">
                    {project.name}
                  </p>
                  {project.code && (
                    <p className="text-[10px] text-blue-700">Project code · {project.code}</p>
                  )}
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {activeTab === 'boundary' && (
                      <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-cyan-100 text-cyan-800 border border-cyan-200">
                        Boundary assignment
                      </span>
                    )}
                    {activeTab === 'geospatial' && segmentGeo && (
                      <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 border border-blue-200">
                        Geospatial survey task
                      </span>
                    )}
                    {activeTab === 'questionnaire' && segmentQ && (
                      <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-200">
                        Questionnaire assignment
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div>
              <h3 className="text-sm font-bold text-gray-800">
                {activeTab === 'boundary'
                  ? 'Boundary Assignment'
                  : activeTab === 'geospatial'
                    ? 'Geospatial Survey Task'
                    : 'Questionnaire Assignment'}
              </h3>
              <p className="text-[11px] text-gray-500 mt-1 leading-relaxed">
                {activeTab === 'boundary'
                  ? 'Assign SHP zone boundaries to enumerators. Each boundary value can only be assigned to one enumerator at a time.'
                  : activeTab === 'geospatial'
                    ? 'Enable or disable the Geospatial Survey task per enumerator. The survey module is coming later; this only controls whether the enumerator sees the geospatial workspace.'
                    : 'Assign published questionnaire forms to enumerators. Boundary and geospatial assignments are preserved separately.'}
              </p>
              {activeTab === 'boundary' && segmentGeo && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={clearingAllAssignments || activeEnumerators.length === 0}
                    onClick={() => {
                      if (!confirm('Clear all boundary (zone) assignments for every active enumerator in this project?')) return;
                      void clearAllEnumeratorWardAssignments();
                    }}
                    className="text-xs font-bold px-3 py-2 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 disabled:opacity-50"
                  >
                    {clearingAllAssignments ? 'Clearing…' : 'Clear all boundaries'}
                  </button>
                </div>
              )}
              {activeTab === 'questionnaire' && segmentQ && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={
                      clearingAllAssignments ||
                      activeEnumerators.length === 0 ||
                      projectQuestionnaires.length === 0
                    }
                    onClick={() => void clearAllEnumeratorQuestionnaireAssignmentsForProject()}
                    className="text-xs font-bold px-3 py-2 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 disabled:opacity-50"
                  >
                    {clearingAllAssignments
                      ? 'Clearing…'
                      : 'Clear all questionnaires (this project)'}
                  </button>
                </div>
              )}
            </div>

            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input
                type="search"
                value={tasksTabSearch}
                onChange={(e) => setTasksTabSearch(e.target.value)}
                placeholder="Search users (name, email, mobile, UID)…"
                className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-9 pr-3 text-sm text-gray-800 placeholder:text-gray-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                aria-label="Search enumerators for tasks"
              />
            </div>

            {!project && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg p-3">
                Open a project from the project picker to assign tasks.
              </p>
            )}
            {project && activeTab === 'boundary' && segmentGeo && zoneAssignOptions.length === 0 && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg p-3">
                No zone layer yet. Open <strong>Geospatial Assignment → Manage SHP</strong>, upload a
                polygon SHP ZIP, pick an assignment field, then return here to assign boundaries.
              </p>
            )}
            {project && activeTab === 'questionnaire' && segmentQ && projectQuestionnaires.length === 0 && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg p-3">
                This project has no questionnaires yet. Build or copy one from the Questionnaire
                workspace first.
              </p>
            )}

            {activeTab === 'boundary' && segmentGeo && duplicateZoneAssignments.length > 0 && (
              <div className="text-[11px] text-amber-800 bg-amber-50 border border-amber-100 rounded-lg p-3 space-y-1">
                <p className="font-semibold">Overlapping boundary assignments detected</p>
                <p className="text-amber-900">
                  The same zone value is assigned to more than one enumerator. Adjust so each
                  boundary has a single holder:
                </p>
                <ul className="list-disc list-inside text-amber-900">
                  {duplicateZoneAssignments.map((d) => (
                    <li key={d.zoneLabel}>
                      <span className="font-medium">{d.zoneLabel}</span>: {d.owners.join(', ')}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Boundary tab: zone value checkboxes */}
            {activeTab === 'boundary' && segmentGeo && project &&
              (activeEnumerators.length === 0 ? (
                <p className="text-sm text-gray-500">No approved enumerators to assign.</p>
              ) : filteredEnumeratorsForTasks.length === 0 ? (
                <p className="text-sm text-gray-500">No users match your search.</p>
              ) : (
                <div className="space-y-3">
                  <p className="text-[11px] text-gray-500">
                    Showing {filteredEnumeratorsForTasks.length}
                    {tasksTabSearch.trim() ? ` of ${activeEnumerators.length}` : ''} enumerator(s)
                  </p>
                  {filteredEnumeratorsForTasks.map((entry) => (
                    <EnumeratorProjectTaskRow
                      key={entry.email}
                      entry={entry}
                      enableGeospatial
                      enableQuestionnaire={false}
                      wardOptions={wardNameOptions}
                      zoneOptions={zoneAssignOptions}
                      zoneFieldLabel={zoneAssignField}
                      questionnaires={[]}
                      wardHeldByOther={wardLocksByEnumeratorEmail.get(entry.email) ?? new Map()}
                      zoneHeldByOther={zoneLocksByEnumeratorEmail.get(entry.email) ?? new Map()}
                      saving={taskSavingEmail === entry.email || clearingAllAssignments}
                      onSave={(next) => void saveEnumeratorProjectAssignment(entry, next)}
                    />
                  ))}
                </div>
              ))}

            {/* Geospatial Survey tab: simple on/off toggle per enumerator */}
            {activeTab === 'geospatial' && segmentGeo && project &&
              (activeEnumerators.length === 0 ? (
                <p className="text-sm text-gray-500">No approved enumerators to assign.</p>
              ) : filteredEnumeratorsForTasks.length === 0 ? (
                <p className="text-sm text-gray-500">No users match your search.</p>
              ) : (
                <div className="space-y-2">
                  <p className="text-[11px] text-gray-500">
                    Showing {filteredEnumeratorsForTasks.length}
                    {tasksTabSearch.trim() ? ` of ${activeEnumerators.length}` : ''} enumerator(s)
                  </p>
                  {filteredEnumeratorsForTasks.map((entry) => {
                    const geoProjectIds = entry.assignedGeospatialProjectIds || [];
                    const isGeoEnabled = project ? geoProjectIds.includes(project.id) : false;
                    const isSaving = taskSavingEmail === entry.email;
                    return (
                      <div key={entry.email} className="bg-gray-50 border border-gray-100 rounded-xl p-3 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-gray-800 truncate">{entry.displayName}</p>
                          <p className="text-[10px] text-gray-500 truncate">{entry.email}</p>
                        </div>
                        <label className="flex items-center gap-2 cursor-pointer select-none shrink-0">
                          <span className={`text-[10px] font-bold uppercase ${isGeoEnabled ? 'text-sky-700' : 'text-gray-400'}`}>
                            {isGeoEnabled ? 'Enabled' : 'Off'}
                          </span>
                          <input
                            type="checkbox"
                            checked={isGeoEnabled}
                            disabled={isSaving}
                            onChange={async () => {
                              try {
                                setTaskSavingEmail(entry.email);
                                setError(null);
                                const allUsers = await loadUsers();
                                await Promise.all(
                                  entry.uids.map(async (uid) => {
                                    const profile = allUsers.find((u) => u.uid === uid);
                                    const existing = [...(profile?.assignedGeospatialProjectIds || [])];
                                    const nextIds = isGeoEnabled
                                      ? existing.filter((id) => id !== project!.id)
                                      : [...new Set([...existing, project!.id])];
                                    await geosurveyApi.updateUser(uid, {
                                      assignedGeospatialProjectIds: nextIds,
                                    } as Partial<UserProfile>);
                                  })
                                );
                                await refreshAll();
                              } catch (e) {
                                setError('Failed to update geospatial survey task');
                              } finally {
                                setTaskSavingEmail(null);
                              }
                            }}
                            className="rounded border-gray-300 text-sky-600 focus:ring-sky-500"
                          />
                        </label>
                      </div>
                    );
                  })}
                </div>
              ))}

            {/* Questionnaire tab: form assignment */}
            {activeTab === 'questionnaire' && segmentQ && project &&
              (activeEnumerators.length === 0 ? (
                <p className="text-sm text-gray-500">No approved enumerators to assign.</p>
              ) : filteredEnumeratorsForTasks.length === 0 ? (
                <p className="text-sm text-gray-500">No users match your search.</p>
              ) : (
                <div className="space-y-3">
                  <p className="text-[11px] text-gray-500">
                    Showing {filteredEnumeratorsForTasks.length}
                    {tasksTabSearch.trim() ? ` of ${activeEnumerators.length}` : ''} enumerator(s)
                  </p>
                  {filteredEnumeratorsForTasks.map((entry) => (
                    <EnumeratorProjectTaskRow
                      key={entry.email}
                      entry={entry}
                      enableGeospatial={false}
                      enableQuestionnaire
                      wardOptions={[]}
                      questionnaires={projectQuestionnaires}
                      wardHeldByOther={new Map()}
                      saving={taskSavingEmail === entry.email || clearingAllAssignments}
                      onSave={(next) => void saveEnumeratorProjectAssignment(entry, next)}
                    />
                  ))}
                </div>
              ))}
          </div>
        )}

        {activeTab === 'create' && (
          <>
            <div>
              <h3 className="text-sm font-bold text-gray-700 mb-2">Create Enumerator Account</h3>
              <p className="text-xs text-gray-500 mb-6">
                Create an account directly for a new enumerator. They will be approved automatically.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1 mb-1 block">Full Name</label>
                <div className="relative">
                  <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                  <input 
                    type="text" 
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="John Doe"
                    className="w-full pl-9 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1 mb-1 block">Email / Username</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                  <input 
                    type="email" 
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="enumerator@ccc.gov.bd"
                    className="w-full pl-9 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1 mb-1 block">Mobile Number</label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                  <input
                    type="tel"
                    value={mobileNumber}
                    onChange={(e) => setMobileNumber(e.target.value)}
                    placeholder="01XXXXXXXXX"
                    className="w-full pl-9 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] font-bold text-gray-400 uppercase tracking-widest ml-1 mb-1 block">Initial Password</label>
                <div className="relative">
                  <Key className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                  <input 
                    type="password" 
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full pl-9 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>
              </div>

              {error && (
                <div className="bg-red-50 text-red-600 p-3 rounded-xl text-xs border border-red-100">
                  {error}
                </div>
              )}

              {success && (
                <div className="bg-green-50 text-green-600 p-3 rounded-xl text-xs border border-green-100 flex items-center gap-2">
                  <Check size={16} /> Account created successfully!
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 text-white font-bold py-3 rounded-xl hover:bg-blue-700 transition-all shadow-lg active:scale-95 disabled:opacity-50"
              >
                {loading ? 'Creating...' : 'Create Account'}
              </button>
            </form>
          </>
        )}

        {activeTab === 'create' && (
          <div className="pt-6 border-t border-gray-100">
            <div className="bg-amber-50 p-4 rounded-2xl flex gap-3">
              <Shield className="text-amber-600 shrink-0" size={20} />
              <div>
                <p className="text-xs font-bold text-amber-800 mb-1">Important Note</p>
                <p className="text-[10px] text-amber-700 leading-relaxed">
                  Accounts are created through the GeoSurvey API and are approved automatically.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
