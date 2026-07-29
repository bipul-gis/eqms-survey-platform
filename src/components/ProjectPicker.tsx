/**
 * ProjectPicker — admin's first screen after sign-in.
 *
 * Lists existing projects, lets the admin open one (which becomes the scope
 * for everything below — geospatial features, questionnaires, user task
 * assignments), and supports create / edit / archive. The picker also seeds
 * the canonical default project the first time it's opened, so an admin
 * never lands on an empty screen.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Folder,
  ChevronRight,
  MapPin,
  ClipboardList,
  AlertCircle,
  RefreshCw,
  Search,
  Loader2,
  Info,
  LogOut
} from 'lucide-react';
import { Project } from '../types';
import { AppFooter } from './AppFooter';
import {
  countAllQuestionnairesByProject,
  deactivateProjectForGeosurvey,
  listProjects,
  searchMisProjects,
  updateProjectSegments,
  activateProjectForGeosurvey
} from '../lib/projects';
import { zoneLayersApi } from '../lib/zoneLayersApi';
import { ASSIGNED_ZONE_BUFFER_METERS } from '../lib/pointInPolygon';

interface ProjectPickerProps {
  currentUserUid: string;
  currentUserName?: string;
  onOpen: (project: Project) => void;
  onSignOut?: () => void;
}

export const ProjectPicker: React.FC<ProjectPickerProps> = ({
  currentUserName,
  onOpen,
  onSignOut
}) => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [allMisProjects, setAllMisProjects] = useState<Project[] | null>(null);
  const [misLoading, setMisLoading] = useState(false);
  const [misError, setMisError] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const misLoadInflight = useRef<Promise<Project[]> | null>(null);

  /** Fast path: only GeoSurvey-activated projects (+ questionnaire counts). */
  const refresh = async () => {
    try {
      setLoading(true);
      setError(null);
      const [list, countMap] = await Promise.all([
        listProjects(),
        countAllQuestionnairesByProject().catch(() => ({} as Record<string, number>))
      ]);
      setProjects(list);
      setCounts(countMap);
    } catch (e) {
      console.error('Failed to load projects:', e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  /** Lazy MIS catalog — fetched once, on first search (or Refresh while searching). */
  const ensureMisProjects = async (): Promise<Project[]> => {
    if (allMisProjects) return allMisProjects;
    if (misLoadInflight.current) return misLoadInflight.current;
    setMisLoading(true);
    setMisError(null);
    const task = searchMisProjects()
      .then((list) => {
        setAllMisProjects(list);
        return list;
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setMisError(msg);
        throw e;
      })
      .finally(() => {
        misLoadInflight.current = null;
        setMisLoading(false);
      });
    misLoadInflight.current = task;
    return task;
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the full MIS list only after the admin starts typing a search.
  useEffect(() => {
    const q = search.trim();
    if (!q) return;
    if (allMisProjects || misLoading || misLoadInflight.current) return;
    const timer = window.setTimeout(() => {
      void ensureMisProjects().catch(() => {
        /* misError already set */
      });
    }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, allMisProjects, misLoading]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects.filter((p) =>
      q ? `${p.name} ${p.code} ${p.description || ''}`.toLowerCase().includes(q) : true
    );
  }, [projects, search]);

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || !allMisProjects) return [] as Project[];
    return allMisProjects
      .filter((p) => `${p.name} ${p.code} ${p.description || ''}`.toLowerCase().includes(q))
      .slice(0, 12);
  }, [allMisProjects, search]);

  const handleToggleActive = async (project: Project, active: boolean) => {
    try {
      setActivatingId(project.id);
      setError(null);
      if (active) {
        await deactivateProjectForGeosurvey(project.id);
        setProjects((prev) => prev.filter((item) => item.id !== project.id));
      } else {
        const saved = await activateProjectForGeosurvey(project);
        setProjects((prev) => {
          const rest = prev.filter((item) => item.id !== saved.id);
          return [...rest, saved].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        });
        setSearch('');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActivatingId(null);
    }
  };

  const showSearchDropdown = search.trim().length > 0;

  return (
    <div className="min-h-[100dvh] bg-gradient-to-br from-slate-50 to-blue-50/40 flex flex-col">
      <header className="bg-white/80 backdrop-blur border-b border-slate-200 px-6 pt-[calc(env(safe-area-inset-top,0px)+1rem)] pb-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="min-w-0">
              <h1 className="text-lg sm:text-xl font-bold text-slate-800 flex items-center gap-2">
                <img
                  src="/eqms-logo.png"
                  alt="EQMS"
                  className="h-7 sm:h-8 w-auto select-none"
                  draggable={false}
                />
                <span>Geosurvey</span>
              </h1>
              <p className="text-[11px] sm:text-xs text-slate-500 truncate">
                Admin · {currentUserName || 'Signed in'} · Select a project to continue
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => {
                void refresh();
                // Drop cached MIS catalog so next search re-fetches.
                setAllMisProjects(null);
                setMisError(null);
              }}
              className="text-xs font-semibold px-3 py-2 rounded-lg text-slate-600 hover:bg-slate-100 inline-flex items-center gap-1"
              title="Reload projects"
            >
              <RefreshCw size={14} /> Refresh
            </button>
            {onSignOut && (
              <button
                onClick={onSignOut}
                className="text-xs font-semibold px-3 py-2 rounded-lg text-slate-600 hover:bg-slate-100 inline-flex items-center gap-1"
                title="Sign out"
              >
                <LogOut size={14} /> Sign out
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-10">
        <div className="flex items-end justify-between gap-3 flex-wrap mb-5">
          <div>
            <h2 className="text-xl sm:text-2xl font-bold text-slate-800">Projects</h2>
            <p className="text-xs sm:text-sm text-slate-500 mt-1">
              Active GeoSurvey projects open immediately. Search to find other MIS projects and
              activate them.
            </p>
          </div>
          <div className="inline-flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 max-w-md">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>Projects are read-only here and managed in MIS.</span>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap mb-5">
          <span className="text-sm font-semibold text-slate-700">Select project</span>
          <div className="relative flex-1 min-w-[220px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search MIS projects by name or code…"
              className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            />
            {showSearchDropdown && (
              <div className="absolute z-20 mt-2 w-full rounded-xl border border-slate-200 bg-white shadow-lg overflow-hidden">
                {misLoading && (
                  <div className="px-4 py-3 text-xs text-slate-500 inline-flex items-center gap-2">
                    <Loader2 size={14} className="animate-spin" />
                    Loading MIS projects…
                  </div>
                )}
                {!misLoading && misError && (
                  <div className="px-4 py-3 text-xs text-red-600 flex items-start justify-between gap-2">
                    <span>Could not load MIS projects: {misError}</span>
                    <button
                      type="button"
                      className="shrink-0 font-semibold text-red-700 hover:underline"
                      onClick={() => {
                        setAllMisProjects(null);
                        void ensureMisProjects().catch(() => undefined);
                      }}
                    >
                      Retry
                    </button>
                  </div>
                )}
                {!misLoading && !misError && searchResults.length === 0 && (
                  <div className="px-4 py-3 text-xs text-slate-500">
                    No MIS projects match “{search.trim()}”.
                  </div>
                )}
                {searchResults.map((p) => {
                  const active = projects.some((item) => item.id === p.id);
                  return (
                    <div
                      key={p.id}
                      className="px-4 py-3 border-b last:border-b-0 border-slate-100"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <label className="flex items-start gap-3 flex-1 min-w-0 cursor-pointer">
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                            checked={active}
                            disabled={activatingId === p.id}
                            onChange={() => {
                              if (activatingId !== p.id) {
                                void handleToggleActive(p, active);
                              }
                            }}
                          />
                          <div className="min-w-0">
                            <div className="text-xs font-bold text-slate-400 uppercase tracking-wide">
                              {p.code || '—'}
                            </div>
                            <div className="text-sm font-semibold text-slate-800 truncate">{p.name}</div>
                            <div className="text-xs text-slate-500 truncate">{p.description || 'PM: —'}</div>
                          </div>
                        </label>
                        <span className="text-[11px] font-semibold text-blue-700 shrink-0">
                          {activatingId === p.id
                            ? active
                              ? 'Removing…'
                              : 'Adding…'
                            : active
                              ? 'GeoSurvey'
                              : 'Mark as GeoSurvey'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 mb-4 flex items-start gap-2 text-sm">
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-semibold">Could not load projects.</p>
              <p className="text-xs">{error}</p>
            </div>
            <button
              onClick={() => void refresh()}
              className="text-xs font-bold bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded"
            >
              Retry
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center text-slate-500 py-16">
            <Loader2 size={20} className="animate-spin mr-2" /> Loading GeoSurvey projects…
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
            <Folder size={32} className="mx-auto mb-3 text-slate-300" />
            <p className="text-sm font-semibold text-slate-700">
              No active GeoSurvey projects yet.
            </p>
            <p className="text-xs text-slate-500 mt-1">
              Search above, then add the MIS projects you want active in GeoSurvey.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                questionnaireCount={counts[p.id] ?? 0}
                busy={activatingId === p.id}
                onOpen={() => onOpen(p)}
                onSegmentsChange={async (segments) => {
                  try {
                    setActivatingId(p.id);
                    setError(null);
                    const saved = await updateProjectSegments(p.id, segments);
                    setProjects((prev) =>
                      prev.map((item) => (item.id === saved.id ? saved : item))
                    );
                    // Keep zone-layer geofence in sync with boundary settings.
                    if (segments.boundaryAppliesTo || typeof segments.questionnaireGeofence === 'boolean') {
                      try {
                        const { items: layers } = await zoneLayersApi.listLayers(p.id);
                        const layer = layers[0];
                        if (layer) {
                          const ba = segments.boundaryAppliesTo || saved.segments?.boundaryAppliesTo;
                          const strict = ba === 'both' || ba === 'questionnaire';
                          await zoneLayersApi.updateLayer(layer.id, { strictGeofence: strict });
                        }
                      } catch (syncErr) {
                        console.warn('Could not sync zone-layer geofence', syncErr);
                      }
                    }
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setActivatingId(null);
                  }
                }}
              />
            ))}
          </div>
        )}
      </main>

      <AppFooter className="border-t border-slate-200 bg-white/70 backdrop-blur" />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Project card
// ---------------------------------------------------------------------------

const ProjectCard: React.FC<{
  project: Project;
  questionnaireCount: number;
  busy?: boolean;
  onOpen: () => void;
  onSegmentsChange: (segments: {
    geospatial?: boolean;
    questionnaire?: boolean;
    questionnaireGeofence?: boolean;
    boundaryAppliesTo?: 'geospatial' | 'questionnaire' | 'both';
  }) => void | Promise<void>;
}> = ({ project, questionnaireCount, busy, onOpen, onSegmentsChange }) => {
  const isArchived = project.isActive === false;
  const segGeo = project.segments?.geospatial === true;
  const segQ = project.segments?.questionnaire !== false;
  const boundaryAppliesTo = project.segments?.boundaryAppliesTo;
  const boundaryGeo = boundaryAppliesTo === 'geospatial' || boundaryAppliesTo === 'both';
  const boundaryQsn = boundaryAppliesTo === 'questionnaire' || boundaryAppliesTo === 'both';

  return (
    <div
      className={`group rounded-xl border bg-white shadow-sm hover:shadow-md transition-all overflow-hidden flex flex-col ${
        isArchived ? 'opacity-70 border-slate-200' : 'border-slate-200'
      }`}
    >
      <div className="px-4 pt-4 pb-3 border-b border-slate-100">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
              Project Code · {project.code || '—'}
            </p>
            <h3 className="text-sm font-bold text-slate-800 mt-0.5 leading-tight line-clamp-2">
              {project.name}
            </h3>
          </div>
          <span className="text-[10px] font-bold uppercase tracking-wider bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded-full shrink-0">
            Active
          </span>
        </div>
        {project.description && (
          <p className="text-[11px] text-slate-500 mt-2 line-clamp-2">
            {project.description}
          </p>
        )}
      </div>

      <div className="px-4 py-3 space-y-2 text-xs text-slate-600">
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
          Survey segments
        </p>
        <label className="flex items-center justify-between gap-2 cursor-pointer select-none">
          <span className="inline-flex items-center gap-1.5">
            <MapPin size={12} className={segGeo ? 'text-blue-600' : 'text-slate-400'} />
            <span className={segGeo ? 'text-blue-800 font-semibold' : 'text-slate-500'}>
              Geospatial
            </span>
          </span>
          <input
            type="checkbox"
            checked={segGeo}
            disabled={busy || isArchived}
            onChange={(e) => {
              const geospatial = e.target.checked;
              void onSegmentsChange({
                geospatial,
                ...(geospatial ? { boundaryAppliesTo: 'both' as const } : {}),
              });
            }}
            className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
          />
        </label>
        <label className="flex items-center justify-between gap-2 cursor-pointer select-none">
          <span className="inline-flex items-center gap-1.5">
            <ClipboardList size={12} className={segQ ? 'text-emerald-600' : 'text-slate-400'} />
            <span className={segQ ? 'text-emerald-800 font-semibold' : 'text-slate-500'}>
              Questionnaire{segQ ? ` · ${questionnaireCount}` : ''}
            </span>
          </span>
          <input
            type="checkbox"
            checked={segQ}
            disabled={busy || isArchived}
            onChange={(e) => {
              const questionnaire = e.target.checked;
              void onSegmentsChange({ questionnaire });
            }}
            className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
          />
        </label>
        {segGeo && (
          <div className="rounded-lg border border-cyan-100 bg-cyan-50/70 px-2.5 py-2 space-y-1.5">
            <p className="text-[10px] font-bold uppercase tracking-wider text-cyan-700">
              Apply boundary to
            </p>
            <label className="flex items-center gap-2 cursor-pointer select-none text-xs">
              <input
                type="checkbox"
                checked={boundaryGeo}
                disabled={busy || isArchived}
                onChange={(e) => {
                  const geo = e.target.checked;
                  const next = geo && boundaryQsn ? 'both' : geo ? 'geospatial' : boundaryQsn ? 'questionnaire' : undefined;
                  void onSegmentsChange({ boundaryAppliesTo: next || ('geospatial' as any) });
                }}
                className="rounded border-slate-300 text-cyan-600 focus:ring-cyan-500"
              />
              <span className={boundaryGeo ? 'text-cyan-900 font-semibold' : 'text-slate-500'}>
                Geospatial Survey
              </span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none text-xs">
              <input
                type="checkbox"
                checked={boundaryQsn}
                disabled={busy || isArchived}
                onChange={(e) => {
                  const qsn = e.target.checked;
                  const next = boundaryGeo && qsn ? 'both' : boundaryGeo ? 'geospatial' : qsn ? 'questionnaire' : undefined;
                  void onSegmentsChange({
                    boundaryAppliesTo: next || ('geospatial' as any),
                    questionnaireGeofence: qsn,
                  });
                }}
                className="rounded border-slate-300 text-cyan-600 focus:ring-cyan-500"
              />
              <span className={boundaryQsn ? 'text-cyan-900 font-semibold' : 'text-slate-500'}>
                Questionnaire Survey
              </span>
            </label>
            <p className="text-[10px] text-slate-500 leading-snug">
              Enumerators can survey inside their assigned SHP zones or within{' '}
              {ASSIGNED_ZONE_BUFFER_METERS} m outside the boundary for checked survey types.
            </p>
          </div>
        )}
        {!segGeo && (
          <p className="text-[10px] text-slate-400 leading-relaxed">
            Turn on Geospatial to import zone SHP files and assign map areas.
          </p>
        )}
      </div>

      <div className="mt-auto px-4 py-3 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between gap-2">
        <button
          onClick={onOpen}
          disabled={isArchived || (!segGeo && !segQ)}
          className="text-xs font-bold text-blue-700 hover:text-blue-900 inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Open <ChevronRight size={14} />
        </button>
        <span className="text-[11px] font-medium text-slate-500">Managed in MIS</span>
      </div>
    </div>
  );
};
