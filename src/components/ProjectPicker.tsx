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
  FolderPlus,
  ChevronRight,
  MapPin,
  ClipboardList,
  Edit3,
  Trash2,
  X,
  AlertCircle,
  RefreshCw,
  Search,
  Archive,
  ArchiveRestore,
  Loader2,
  LogOut
} from 'lucide-react';
import { Project } from '../types';
import { AppFooter } from './AppFooter';
import {
  countAllQuestionnairesByProject,
  createProject,
  deleteProject,
  ensureDefaultProject,
  listProjects,
  updateProject
} from '../lib/projects';

interface ProjectPickerProps {
  currentUserUid: string;
  currentUserName?: string;
  onOpen: (project: Project) => void;
  onSignOut?: () => void;
}

export const ProjectPicker: React.FC<ProjectPickerProps> = ({
  currentUserUid,
  currentUserName,
  onOpen,
  onSignOut
}) => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Project | 'new' | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});

  const refresh = async () => {
    try {
      setLoading(true);
      setError(null);
      // First, ensure the canonical default project exists. This is idempotent.
      await ensureDefaultProject(currentUserUid);
      // Run the project list + per-project questionnaire counts concurrently.
      // The counts are now derived from a single `getDocs` of all questionnaires
      // instead of N per-project queries — eliminates the linear-with-projects
      // round-trip penalty on the picker.
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

  const handleArchive = async (p: Project) => {
    if (!confirm(`Archive "${p.name}"?\nIt will be hidden from the default project list.`))
      return;
    try {
      await updateProject(p.id, { isActive: false });
      await refresh();
    } catch (e) {
      alert(`Failed to archive: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleRestore = async (p: Project) => {
    try {
      await updateProject(p.id, { isActive: true });
      await refresh();
    } catch (e) {
      alert(`Failed to restore: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleDelete = async (p: Project) => {
    if (
      !confirm(
        `Permanently DELETE "${p.name}"?\nThis only removes the project record. ` +
          `Existing questionnaires/responses keep their projectId reference.`
      )
    )
      return;
    try {
      await deleteProject(p.id);
      await refresh();
    } catch (e) {
      alert(`Failed to delete: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-gradient-to-br from-slate-50 to-blue-50/40 flex flex-col">
      <header className="bg-white/80 backdrop-blur border-b border-slate-200 px-6 py-4">
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
              Each project is a self-contained engagement. Geospatial wards,
              questionnaires, and enumerator task assignments are scoped to
              the project you open.
            </p>
          </div>
          <button
            onClick={() => setEditing('new')}
            className="text-sm font-bold bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg flex items-center gap-2 shadow-md shadow-blue-200"
          >
            <FolderPlus size={16} /> New Project
          </button>
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
            {!showArchived && (
              <p className="text-xs text-slate-500 mt-1">
                Click "New Project" to create one.
              </p>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                questionnaireCount={counts[p.id] ?? 0}
                onOpen={() => onOpen(p)}
                onEdit={() => setEditing(p)}
                onArchive={() => void handleArchive(p)}
                onRestore={() => void handleRestore(p)}
                onDelete={() => void handleDelete(p)}
              />
            ))}
          </div>
        )}
      </main>

      <AppFooter className="border-t border-slate-200 bg-white/70 backdrop-blur" />

      {editing && (
        <ProjectEditorDialog
          existing={editing === 'new' ? null : editing}
          currentUserUid={currentUserUid}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
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
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}> = ({ project, questionnaireCount, onOpen, onEdit, onArchive, onRestore, onDelete }) => {
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
        <div className="flex items-center gap-1">
          <button
            onClick={onEdit}
            className="p-1.5 rounded hover:bg-slate-200 text-slate-600"
            title="Edit project"
          >
            <Edit3 size={13} />
          </button>
          {isArchived ? (
            <button
              onClick={onRestore}
              className="p-1.5 rounded hover:bg-emerald-50 text-emerald-700"
              title="Restore"
            >
              <ArchiveRestore size={13} />
            </button>
          ) : (
            <button
              onClick={onArchive}
              className="p-1.5 rounded hover:bg-amber-50 text-amber-700"
              title="Archive"
            >
              <Archive size={13} />
            </button>
          )}
          <button
            onClick={onDelete}
            className="p-1.5 rounded hover:bg-red-50 text-red-700"
            title="Delete (record only)"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Editor dialog
// ---------------------------------------------------------------------------

const ProjectEditorDialog: React.FC<{
  existing: Project | null;
  currentUserUid: string;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}> = ({ existing, currentUserUid, onClose, onSaved }) => {
  const [name, setName] = useState(existing?.name ?? '');
  const [code, setCode] = useState(existing?.code ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [geospatial, setGeospatial] = useState(existing?.segments?.geospatial !== false);
  const [questionnaire, setQuestionnaire] = useState(
    existing?.segments?.questionnaire !== false
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) {
      setErr('Project name is required.');
      return;
    }
    if (!geospatial && !questionnaire) {
      setErr('Enable at least one segment (geospatial or questionnaire).');
      return;
    }
    try {
      setSaving(true);
      setErr(null);
      if (existing) {
        await updateProject(existing.id, {
          name: name.trim(),
          code: code.trim(),
          description: description.trim(),
          segments: { geospatial, questionnaire }
        });
      } else {
        await createProject(
          {
            name: name.trim(),
            code: code.trim(),
            description: description.trim(),
            segments: { geospatial, questionnaire },
            isActive: true
          },
          currentUserUid
        );
      }
      await onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[2000] bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between bg-gradient-to-r from-blue-50 to-indigo-50">
          <h3 className="text-sm font-bold text-slate-800">
            {existing ? 'Edit Project' : 'New Project'}
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-200 text-slate-500"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
              Project Name *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Consultancy services GPS Technology Assisted Mapping and Listing Exercise"
              className="w-full text-sm px-3 py-2 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
              Project Code
            </label>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. 20612601105"
              className="w-full text-sm px-3 py-2 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Optional notes shown on the project card."
              className="w-full text-sm px-3 py-2 border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
            />
          </div>
          <div className="grid grid-cols-2 gap-3 pt-1">
            <label className="flex items-center gap-2 text-xs text-slate-700 px-3 py-2 border border-slate-200 rounded-md cursor-pointer">
              <input
                type="checkbox"
                checked={geospatial}
                onChange={(e) => setGeospatial(e.target.checked)}
              />
              <MapPin size={13} className="text-blue-600" />
              Geospatial Survey
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-700 px-3 py-2 border border-slate-200 rounded-md cursor-pointer">
              <input
                type="checkbox"
                checked={questionnaire}
                onChange={(e) => setQuestionnaire(e.target.checked)}
              />
              <ClipboardList size={13} className="text-emerald-600" />
              Questionnaire Survey
            </label>
          </div>
          {err && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
              {err}
            </p>
          )}
        </div>
        <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-end gap-2 bg-slate-50">
          <button
            onClick={onClose}
            className="text-xs font-semibold px-3 py-2 rounded-md text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="text-xs font-bold bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {saving && <Loader2 size={13} className="animate-spin" />}
            {existing ? 'Save changes' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  );
};
