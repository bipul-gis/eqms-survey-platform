import type { Request } from 'express';
import {
  createAuthSession,
  ensureUserPassword,
  getAuthSession,
  revokeAuthSession,
  setUserPassword,
  verifyUserPassword,
} from './authStore';
import {
  createUser,
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
    if (isWhitelistedAdmin(user.email) && password === getDefaultPassword()) {
      await ensureUserPassword(user.id, password);
    } else {
      return null;
    }
  }

  const session = await createAuthSession(user.id);
  return { user, profile: userToProfile(user), sessionToken: session.token };
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
  return userToProfile(user);
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
