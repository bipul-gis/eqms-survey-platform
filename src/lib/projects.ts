/**
 * Project CRUD + default-project seeding.
 *
 * A "project" is the top-level container an admin selects on login. It groups
 * Geospatial work (wards, features) and Questionnaire work (questionnaires,
 * responses) under one name + code so the rest of the admin tooling can scope
 * its UI without changing how the underlying Firestore data is partitioned
 * (questionnaires reference `projectId`; geospatial features remain global).
 */

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from 'firebase/firestore';
import { db } from './firebase';
import { Project } from '../types';

/**
 * ID of the canonical first project. Used as the migration target for any
 * legacy questionnaires that pre-date the project layer. Generated from the
 * project code so it's stable across reseeding.
 */
export const DEFAULT_PROJECT_ID = 'project_20612601105';

export const DEFAULT_PROJECT_SEED: Omit<Project, 'createdAt' | 'updatedAt'> = {
  id: DEFAULT_PROJECT_ID,
  name: 'Consultancy services GPS Technology Assisted Mapping and Listing Exercise',
  code: '20612601105',
  description:
    'Default engagement. Geospatial mapping/listing alongside questionnaire-driven enumeration. Add more projects to track parallel engagements.',
  segments: { geospatial: true, questionnaire: true },
  isActive: true
};

/**
 * Idempotent seed: ensures the canonical project doc exists. If it already
 * exists, we leave it alone (admin may have renamed it / edited description);
 * if it doesn't, we create it with the canonical seed payload. This is safe
 * to call on every admin load.
 */
export const ensureDefaultProject = async (createdBy: string): Promise<Project> => {
  const ref = doc(db, 'projects', DEFAULT_PROJECT_ID);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    return { ...(snap.data() as Project), id: DEFAULT_PROJECT_ID };
  }
  await setDoc(ref, {
    ...DEFAULT_PROJECT_SEED,
    createdBy,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  return { ...DEFAULT_PROJECT_SEED };
};

export const listProjects = async (): Promise<Project[]> => {
  const snap = await getDocs(collection(db, 'projects'));
  const list: Project[] = [];
  snap.forEach((d) => {
    list.push({ ...(d.data() as Project), id: d.id });
  });
  // Sort: active first, then alphabetical by name.
  list.sort((a, b) => {
    const aa = a.isActive === false ? 1 : 0;
    const bb = b.isActive === false ? 1 : 0;
    if (aa !== bb) return aa - bb;
    return (a.name || '').localeCompare(b.name || '');
  });
  return list;
};

export const createProject = async (
  data: Omit<Project, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
  createdBy: string
): Promise<Project> => {
  const payload = {
    name: data.name,
    code: data.code,
    description: data.description ?? '',
    segments: data.segments ?? { geospatial: true, questionnaire: true },
    isActive: data.isActive ?? true,
    createdBy,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  if (data.id) {
    await setDoc(doc(db, 'projects', data.id), payload);
    return { ...payload, id: data.id } as Project;
  }
  const ref = await addDoc(collection(db, 'projects'), payload);
  return { ...payload, id: ref.id } as Project;
};

export const updateProject = async (
  id: string,
  patch: Partial<Project>
): Promise<void> => {
  const { id: _drop, createdAt, ...rest } = patch;
  void _drop;
  void createdAt;
  await updateDoc(doc(db, 'projects', id), {
    ...rest,
    updatedAt: serverTimestamp()
  });
};

export const deleteProject = async (id: string): Promise<void> => {
  await deleteDoc(doc(db, 'projects', id));
};

/**
 * Count questionnaires under a project. Used on the project list card so the
 * admin can see at a glance how many surveys live in each project.
 *
 * NOTE: Prefer `countAllQuestionnairesByProject` when you need counts for
 * more than one project — that does a single full scan instead of N round-
 * trips. This per-project helper is kept for completeness.
 */
export const countQuestionnairesInProject = async (
  projectId: string
): Promise<number> => {
  const q = query(collection(db, 'questionnaires'), where('projectId', '==', projectId));
  const snap = await getDocs(q);
  return snap.size;
};

/**
 * One-shot count of questionnaires grouped by project. A single `getDocs`
 * call replaces the previous N+1 query pattern in the project picker (which
 * grew linearly with project count). Legacy questionnaires without a
 * `projectId` are bucketed into the canonical default project.
 */
export const countAllQuestionnairesByProject = async (): Promise<
  Record<string, number>
> => {
  const snap = await getDocs(collection(db, 'questionnaires'));
  const counts: Record<string, number> = {};
  snap.forEach((d) => {
    const data = d.data() as { projectId?: string };
    const pid = data.projectId || DEFAULT_PROJECT_ID;
    counts[pid] = (counts[pid] || 0) + 1;
  });
  return counts;
};
