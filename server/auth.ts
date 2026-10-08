import type { Request } from 'express';
import {
  createAuthSession,
  createPasswordResetToken,
  ensureUserPassword,
  getAuthSession,
  getPasswordHash,
  revokeAuthSession,
  revokeUserAuthSessions,
  setUserPassword,
  verifyAndConsumeResetToken,
  verifyUserPassword,
} from './authStore';
import {
  createUser,
  clearDeletedEmailBlock,
  findUserByEmail,
  findUserById,
  isUserBlocked,
  isWhitelistedAdmin,
  userToProfile,
} from './userStore';
import { randomUUID } from 'crypto';
import { getDefaultPassword } from './passwordUtils';

export function extractSessionToken(req: Request): string {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return '';
}

export async function authenticateWithPassword(email: string, password: string) {
  const user = await findUserByEmail(email);
  if (!user) return null;
  if (user.status === 'rejected') return null;
  if (await isUserBlocked(user.id, user.email)) return null;

  const ok = await verifyUserPassword(user.id, password);
  if (!ok) {
    // Only permit initial default password seeding if NO password hash exists yet in DB
    const hasHash = await getPasswordHash(user.id);
    if (!hasHash && isWhitelistedAdmin(user.email) && password === getDefaultPassword()) {
      await ensureUserPassword(user.id, password);
    } else {
      return null;
    }
  }

  const session = await createAuthSession(user.id);
  return { user, profile: userToProfile(user), sessionToken: session.token };
}

export async function changePasswordForUser(userId: string, oldPassword: string, newPassword: string): Promise<void> {
  if (!newPassword || newPassword.length < 6) {
    throw new Error('New password must be at least 6 characters.');
  }
  const user = await findUserById(userId);
  if (!user) {
    throw new Error('User not found.');
  }
  const ok = await verifyUserPassword(userId, oldPassword);
  if (!ok) {
    // Check if whitelisted admin with default password ONLY if no hash exists yet
    const hasHash = await getPasswordHash(userId);
    if (!hasHash && isWhitelistedAdmin(user.email) && oldPassword === getDefaultPassword()) {
      // Allowed for initial transition
    } else {
      throw new Error('Current password is incorrect.');
    }
  }
  await setUserPassword(userId, newPassword);
  await revokeUserAuthSessions(userId);
}

export async function registerEnumerator(input: {
  email: string;
  password: string;
  displayName: string;
  mobileNumber?: string;
}) {
  const email = input.email.trim().toLowerCase();
  if (await findUserByEmail(email)) {
    throw new Error('An account with this email already exists.');
  }
  const uid = randomUUID();
  if (await isUserBlocked(uid, email)) {
    throw new Error('This email cannot be used to register.');
  }
  const user = await createUser({
    id: uid,
    email,
    displayName: input.displayName,
    mobileNumber: input.mobileNumber,
    role: 'enumerator',
    status: isWhitelistedAdmin(email) ? 'approved' : 'pending',
  });
  await setUserPassword(user.id, input.password);
  const session = await createAuthSession(user.id);
  return { user, profile: userToProfile(user), sessionToken: session.token };
}

export async function resolveSessionByToken(token: string) {
  const session = await getAuthSession(token);
  if (!session) return null;
  const user = await findUserById(session.userId);
  if (!user) {
    await revokeAuthSession(token);
    return null;
  }
  if (await isUserBlocked(user.id, user.email)) {
    await revokeAuthSession(token);
    return null;
  }
  return { user, profile: userToProfile(user), sessionToken: token };
}

export async function adminCreateEnumerator(
  adminId: string,
  input: { email: string; password: string; displayName: string; mobileNumber?: string }
) {
  const email = input.email.trim().toLowerCase();
  if (await findUserByEmail(email)) {
    throw new Error('An account with this email already exists.');
  }
  const uid = randomUUID();
  const user = await createUser({
    id: uid,
    email,
    displayName: input.displayName,
    mobileNumber: input.mobileNumber,
    role: 'enumerator',
    status: 'approved',
  });
  await setUserPassword(user.id, input.password);
  await clearDeletedEmailBlock(email);
  return userToProfile(user);
}

/** Replace an enumerator's password and return the one-time cleartext to the admin. */
export async function adminResetEnumeratorPassword(userId: string): Promise<string> {
  const user = await findUserById(userId);
  if (!user || user.role !== 'enumerator') {
    throw new Error('Enumerator account not found.');
  }
  const password = randomUUID().replace(/-/g, '') + 'aA7!';
  await setUserPassword(user.id, password);
  await revokeUserAuthSessions(user.id);
  return password;
}

export async function verifyIdentityForPasswordReset(
  email: string,
  mobileNumber: string
): Promise<{ resetToken: string; displayName: string }> {
  const normEmail = email.trim().toLowerCase();
  const user = await findUserByEmail(normEmail);
  if (!user) {
    throw new Error('No account found for this email address.');
  }
  if (user.status === 'rejected') {
    throw new Error('This account has been rejected.');
  }

  const userMobile = (user.mobileNumber || '').replace(/\D/g, '');
  const providedMobile = mobileNumber.replace(/\D/g, '');
  if (!userMobile || userMobile !== providedMobile) {
    throw new Error('Mobile number does not match registered account.');
  }

  const resetToken = await createPasswordResetToken(user.id);
  return { resetToken, displayName: user.displayName || user.email };
}

export async function completePasswordReset(resetToken: string, newPassword: string): Promise<void> {
  if (!newPassword || newPassword.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }
  const userId = await verifyAndConsumeResetToken(resetToken);
  if (!userId) {
    throw new Error('Reset session has expired or is invalid. Please verify again.');
  }
  await setUserPassword(userId, newPassword);
  await revokeUserAuthSessions(userId);
}

export async function requestPasswordReset(email: string, mobileNumber: string): Promise<string> {
  const user = await findUserByEmail(email);
  if (!user || user.role !== 'enumerator') {
    throw new Error('No enumerator account found for this email.');
  }
  const mobile = (user.mobileNumber || '').replace(/\D/g, '');
  const provided = mobileNumber.replace(/\D/g, '');
  if (!mobile || mobile !== provided) {
    throw new Error('Mobile number does not match our records.');
  }
  const tempPassword = getDefaultPassword();
  await setUserPassword(user.id, tempPassword);
  return tempPassword;
}
