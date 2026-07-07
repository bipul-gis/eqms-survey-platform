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
  await pool.query('DELETE FROM auth_sessions WHERE user_id = $1', [userId]);
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
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await pool.query('DELETE FROM auth_sessions WHERE token = $1', [token]);
    return null;
  }
  return {
    id: row.id,
    userId: row.user_id,
    token: row.token,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export async function revokeAuthSession(token: string): Promise<void> {
  await pool.query('DELETE FROM auth_sessions WHERE token = $1', [token]);
}
