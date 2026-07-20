/**
 * Projects loaded from MIS via GeoSurvey API.
 * GeoSurvey no longer creates or manages its own project registry.
 */

import { geosurveyApi } from './geosurveyApi';
import { Project } from '../types';

/** Legacy default project id — used only when bucketing questionnaires without projectId. */
export const DEFAULT_PROJECT_ID = 'project_20612601105';

export const listProjects = async (): Promise<Project[]> => {
  const { items } = await geosurveyApi.listGeosurveyProjects();
  return items;
};

export const searchMisProjects = async (): Promise<Project[]> => {
  const { items } = await geosurveyApi.listMisProjects();
  return items;
};

export const activateProjectForGeosurvey = async (project: Project): Promise<Project> => {
  const { item } = await geosurveyApi.activateGeosurveyProject(project);
  return item;
};

export const deactivateProjectForGeosurvey = async (projectId: string): Promise<void> => {
  await geosurveyApi.deactivateGeosurveyProject(projectId);
};

export const countAllQuestionnairesByProject = async (): Promise<Record<string, number>> => {
  return geosurveyApi.questionnaireCounts();
};

/** @deprecated Projects are managed in MIS — no local create. */
export const createProject = async (): Promise<never> => {
  throw new Error('Projects are managed in MIS. Create projects in the MIS platform.');
};

/** @deprecated */
export const updateProject = async (): Promise<never> => {
  throw new Error('Projects are managed in MIS.');
};

/** @deprecated */
export const deleteProject = async (): Promise<never> => {
  throw new Error('Projects are managed in MIS.');
};

/** @deprecated */
export const ensureDefaultProject = async (): Promise<Project> => {
  const projects = await listProjects();
  if (projects.length > 0) return projects[0];
  throw new Error('No MIS projects available. Add projects in MIS first.');
};

export const countQuestionnairesInProject = async (projectId: string): Promise<number> => {
  const counts = await countAllQuestionnairesByProject();
  return counts[projectId] || 0;
};
