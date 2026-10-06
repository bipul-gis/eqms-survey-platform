import { randomBytes, randomUUID } from 'crypto';
import { pool } from './db';
import { getDefaultPassword, hashPassword, verifyPassword } from './passwordUtils';

export interface AuthSession {
  id: string;
  userId: string;
  token: string;
  expiresAt: string;
  createdAt: string;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Renew a session once it is inside the last half of its lifetime. */
const SESSION_RENEW_THRESHOLD_MS = SESSION_TTL_MS / 2;

export async function getPasswordHash(userId: string): Promise<string | null> {
  const { rows } = await pool.query(
    'SELECT password_hash FROM user_credentials WHERE user_id = $1',
    [userId]
  );
  return rows[0]?.password_hash ?? null;
}

export async function setUserPassword(userId: string, password: string): Promise<void> {
  const hash = hashPassword(password);
  await pool.query(
    `INSERT INTO user_credentials (user_id, password_hash, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()`,
    [userId, hash]
  );
}

export async function verifyUserPassword(userId: string, password: string): Promise<boolean> {
  const stored = await getPasswordHash(userId);
  if (!stored) return false;
  return verifyPassword(password, stored);
}

export async function ensureUserPassword(userId: string, password?: string): Promise<void> {
  const existing = await getPasswordHash(userId);
  if (existing) return;
  await setUserPassword(userId, password ?? getDefaultPassword());
}

export async function createAuthSession(userId: string): Promise<AuthSession> {
  const token = randomBytes(32).toString('hex');
  const id = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  // Keep this account's other live sessions so the same user can stay signed
  // in on phone and desktop at once; only drop rows that already expired.
  await pool.query('DELETE FROM auth_sessions WHERE user_id = $1 AND expires_at <= NOW()', [
    userId,
  ]);
  await pool.query(
    `INSERT INTO auth_sessions (id, user_id, token, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, userId, token, expiresAt.toISOString(), now.toISOString()]
  );
  return {
    id,
    userId,
    token,
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
  };
}

export async function getAuthSession(token: string): Promise<AuthSession | null> {
  const { rows } = await pool.query(
    `SELECT id, user_id, token, expires_at, created_at
     FROM auth_sessions WHERE token = $1`,
    [token]
  );
  const row = rows[0];
  if (!row) return null;
  const expiresAtMs = new Date(row.expires_at).getTime();
  if (expiresAtMs <= Date.now()) {
    await pool.query('DELETE FROM auth_sessions WHERE token = $1', [token]);
    return null;
  }

  // Sliding window: an actively used session is renewed so field staff are not
  // signed out mid-survey when the original 7 days run out.
  let expiresAt = row.expires_at;
  if (expiresAtMs - Date.now() < SESSION_RENEW_THRESHOLD_MS) {
    const renewed = new Date(Date.now() + SESSION_TTL_MS);
    await pool.query('UPDATE auth_sessions SET expires_at = $2 WHERE token = $1', [
      token,
      renewed.toISOString(),
    ]);
    expiresAt = renewed.toISOString();
  }

  return {
    id: row.id,
    userId: row.user_id,
    token: row.token,
    expiresAt,
    createdAt: row.created_at,
  };
}

export async function revokeAuthSession(token: string): Promise<void> {
  await pool.query('DELETE FROM auth_sessions WHERE token = $1', [token]);
}

export async function revokeUserAuthSessions(userId: string): Promise<void> {
  await pool.query('DELETE FROM auth_sessions WHERE user_id = $1', [userId]);
}

export async function createPasswordResetToken(userId: string): Promise<string> {
  const tokenId = randomUUID();
  const resetToken = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes validity

  // Invalidate any previous unused reset tokens for this user
  await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]);

  await pool.query(
    `INSERT INTO password_reset_tokens (id, user_id, reset_token, expires_at, used)
     VALUES ($1, $2, $3, $4, FALSE)`,
    [tokenId, userId, resetToken, expiresAt.toISOString()]
  );
  return resetToken;
}

export async function verifyAndConsumeResetToken(resetToken: string): Promise<string | null> {
  const res = await pool.query<{ user_id: string; expires_at: string; used: boolean }>(
    `SELECT user_id, expires_at, used FROM password_reset_tokens WHERE reset_token = $1`,
    [resetToken]
  );
  if (!res.rowCount) return null;
  const row = res.rows[0];
  if (row.used) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await pool.query('DELETE FROM password_reset_tokens WHERE reset_token = $1', [resetToken]);
    return null;
  }

  // Mark token as used
  await pool.query('UPDATE password_reset_tokens SET used = TRUE WHERE reset_token = $1', [resetToken]);
  return row.user_id;
}
