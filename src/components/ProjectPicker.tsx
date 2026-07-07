/**
 * ProjectPicker — admin's first screen after sign-in.
 *
 * Lists existing projects, lets the admin open one (which becomes the scope
 * for everything below — geospatial features, questionnaires, user task
 * assignments), and supports create / edit / archive. The picker also seeds
 * the canonical default project the first time it's opened, so an admin
 * never lands on an empty screen.
 */

import React, { useEffect, useMemo, useState } from 'react';
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
import { countAllQuestionnairesByProject, listProjects } from '../lib/projects';

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
  const [showArchived, setShowArchived] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});

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

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects
      .filter((p) => (showArchived ? p.isActive === false : p.isActive !== false))
      .filter((p) =>
        q
          ? `${p.name} ${p.code} ${p.description || ''}`.toLowerCase().includes(q)
          : true
      );
  }, [projects, search, showArchived]);

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
              onClick={() => void refresh()}
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
              Projects are managed in MIS. Use this list to search and open a
              project for its geospatial and questionnaire workspaces.
            </p>
          </div>
          <div className="inline-flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800 max-w-md">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>Projects are read-only here and managed in MIS.</span>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-wrap mb-5">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects by name, code, or description…"
              className="w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            />
          </div>
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
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
            <Loader2 size={20} className="animate-spin mr-2" /> Loading projects…
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
            <Folder size={32} className="mx-auto mb-3 text-slate-300" />
            <p className="text-sm font-semibold text-slate-700">
              {showArchived ? 'No archived projects.' : 'No projects yet.'}
            </p>
            {!showArchived && <p className="text-xs text-slate-500 mt-1">Create projects in MIS.</p>}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                questionnaireCount={counts[p.id] ?? 0}
                onOpen={() => onOpen(p)}
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
  onOpen: () => void;
}> = ({ project, questionnaireCount, onOpen }) => {
  const isArchived = project.isActive === false;
  const segGeo = project.segments?.geospatial !== false;
  const segQ = project.segments?.questionnaire !== false;

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
          {isArchived && (
            <span className="text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full shrink-0">
              Archived
            </span>
          )}
        </div>
        {project.description && (
          <p className="text-[11px] text-slate-500 mt-2 line-clamp-2">
            {project.description}
          </p>
        )}
      </div>

      <div className="px-4 py-3 flex items-center gap-2 text-xs text-slate-600 flex-wrap">
        {segGeo && (
          <span className="inline-flex items-center gap-1 bg-blue-50 text-blue-700 border border-blue-200 rounded-md px-1.5 py-0.5">
            <MapPin size={11} /> Geospatial
          </span>
        )}
        {segQ && (
          <span className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-md px-1.5 py-0.5">
            <ClipboardList size={11} /> Questionnaire · {questionnaireCount}
          </span>
        )}
      </div>

      <div className="mt-auto px-4 py-3 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between gap-2">
        <button
          onClick={onOpen}
          disabled={isArchived}
          className="text-xs font-bold text-blue-700 hover:text-blue-900 inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Open <ChevronRight size={14} />
        </button>
        <span className="text-[11px] font-medium text-slate-500">Managed in MIS</span>
      </div>
    </div>
  );
};
