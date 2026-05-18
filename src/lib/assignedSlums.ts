import { UserProfile } from '../types';
import { findSlumById, SlumRecord } from './slumRegistry';

export function assignedSlumIdsFromUserProfile(data: UserProfile): string[] {
  const list = data.assignedSlumIds;
  if (Array.isArray(list) && list.length > 0) {
    return [...new Set(list.map((id) => String(id).trim()).filter(Boolean))].sort();
  }
  return [];
}

export function assignedSlumsForProject(profile: UserProfile | null, projectId: string): string[] {
  if (!profile) return [];
  const perProject = profile.projectSlumAssignments?.[projectId];
  if (Array.isArray(perProject) && perProject.length > 0) {
    return [...new Set(perProject.map((id) => String(id).trim()).filter(Boolean))].sort();
  }
  return assignedSlumIdsFromUserProfile(profile);
}

export function resolveAssignedSlumRecords(profile: UserProfile | null, projectId: string): SlumRecord[] {
  return assignedSlumsForProject(profile, projectId)
    .map((id) => findSlumById(id))
    .filter((r): r is SlumRecord => !!r);
}
