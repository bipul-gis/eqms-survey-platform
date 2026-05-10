import type { User } from 'firebase/auth';
import type { UserProfile } from '../types';

/** Stored when no enumerator has edited yet or the actor is not an enumerator (e.g. admin / system). */
export const ENUMERATOR_UPDATED_BY_PLACEHOLDER = 'ccc_landmark_import';

/**
 * `updatedBy` must contain an enumerator email only — never an admin account email.
 */
export function stampsForUpdatedBy(
  user: User | null,
  userProfile: UserProfile | null
): { updatedBy: string; updatedByUid: string | null } {
  if (!user?.email) {
    return { updatedBy: ENUMERATOR_UPDATED_BY_PLACEHOLDER, updatedByUid: null };
  }
  if (userProfile?.role === 'admin') {
    return { updatedBy: ENUMERATOR_UPDATED_BY_PLACEHOLDER, updatedByUid: null };
  }
  if (userProfile?.role === 'enumerator') {
    return { updatedBy: user.email, updatedByUid: user.uid };
  }
  return { updatedBy: ENUMERATOR_UPDATED_BY_PLACEHOLDER, updatedByUid: null };
}
