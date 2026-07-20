import { pool } from './db';

export interface DbUser {
  id: string;
  email: string;
  displayName: string;
  mobileNumber?: string;
  role: 'admin' | 'enumerator';
  status: 'pending' | 'approved' | 'rejected';
  landmarkIconScale?: number;
  assignedWardName?: string | null;
  assignedWardNames: string[];
  projectWardAssignments: Record<string, string[]>;
  assignedQuestionnaireIds: string[];
  assignedSlumIds: string[];
  projectSlumAssignments: Record<string, string[]>;
  createdAt: string;
  updatedAt: string;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v).trim()).filter(Boolean);
      }
    } catch {
      /* ignore */
    }
  }
  return [];
}

function asStringMap(value: unknown): Record<string, string[]> {
  const raw =
    typeof value === 'string' && value.trim()
      ? (() => {
          try {
            return JSON.parse(value);
          } catch {
            return null;
          }
        })()
      : value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] = asStringArray(v);
  }
  return out;
}

function rowToUser(row: Record<string, unknown>): DbUser {
  return {
    id: row.id as string,
    email: row.email as string,
    displayName: (row.display_name as string) || '',
    mobileNumber: (row.mobile_number as string) || undefined,
    role: row.role as DbUser['role'],
    status: row.status as DbUser['status'],
    landmarkIconScale: row.landmark_icon_scale as number | undefined,
    assignedWardName: row.assigned_ward_name as string | null | undefined,
    assignedWardNames: asStringArray(row.assigned_ward_names),
    projectWardAssignments: asStringMap(row.project_ward_assignments),
    assignedQuestionnaireIds: asStringArray(row.assigned_questionnaire_ids),
    assignedSlumIds: asStringArray(row.assigned_slum_ids),
    projectSlumAssignments: asStringMap(row.project_slum_assignments),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function userToProfile(user: DbUser) {
  return {
    uid: user.id,
    email: user.email,
    displayName: user.displayName,
    mobileNumber: user.mobileNumber,
    role: user.role,
    status: user.status,
    landmarkIconScale: user.landmarkIconScale,
    assignedWardName: user.assignedWardName,
    assignedWardNames: user.assignedWardNames,
    projectWardAssignments: user.projectWardAssignments,
    assignedQuestionnaireIds: user.assignedQuestionnaireIds,
    assignedSlumIds: user.assignedSlumIds,
    projectSlumAssignments: user.projectSlumAssignments,
  };
}

const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || 'bipul.paul@eqmscl.com,admin@ccc.gov.bd')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
);

export function isWhitelistedAdmin(email: string): boolean {
  return ADMIN_EMAILS.has(email.trim().toLowerCase());
}

export async function findUserByEmail(email: string): Promise<DbUser | null> {
  const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  return rows[0] ? rowToUser(rows[0]) : null;
}

export async function findUserById(id: string): Promise<DbUser | null> {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] ? rowToUser(rows[0]) : null;
}

export async function listUsers(): Promise<DbUser[]> {
  const { rows } = await pool.query('SELECT * FROM users ORDER BY display_name, email');
  return rows.map(rowToUser);
}

export async function createUser(input: {
  id: string;
  email: string;
  displayName: string;
  mobileNumber?: string;
  role: 'admin' | 'enumerator';
  status: 'pending' | 'approved' | 'rejected';
}): Promise<DbUser> {
  const email = input.email.trim().toLowerCase();
  const role = isWhitelistedAdmin(email) ? 'admin' : input.role;
  const status = isWhitelistedAdmin(email) ? 'approved' : input.status;
  const { rows } = await pool.query(
    `INSERT INTO users (id, email, display_name, mobile_number, role, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [input.id, email, input.displayName, input.mobileNumber ?? null, role, status]
  );
  return rowToUser(rows[0]);
}

export async function updateUser(id: string, patch: Partial<DbUser>): Promise<DbUser | null> {
  const existing = await findUserById(id);
  if (!existing) return null;
  // Only apply keys that are explicitly present (ignore undefined) so partial
  // PATCH bodies do not wipe unrelated assignment fields.
  const merged: DbUser = { ...existing, id };
  for (const [key, value] of Object.entries(patch) as [keyof DbUser, DbUser[keyof DbUser]][]) {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key as string] = value;
    }
  }
  if (isWhitelistedAdmin(merged.email)) {
    merged.role = 'admin';
    merged.status = 'approved';
  }
  const { rows } = await pool.query(
    `UPDATE users SET
      display_name = $2, mobile_number = $3, role = $4, status = $5,
      landmark_icon_scale = $6, assigned_ward_name = $7, assigned_ward_names = $8,
      project_ward_assignments = $9, assigned_questionnaire_ids = $10,
      assigned_slum_ids = $11, project_slum_assignments = $12, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [
      id,
      merged.displayName,
      merged.mobileNumber ?? null,
      merged.role,
      merged.status,
      merged.landmarkIconScale ?? null,
      merged.assignedWardName ?? null,
      JSON.stringify(merged.assignedWardNames || []),
      JSON.stringify(merged.projectWardAssignments || {}),
      JSON.stringify(merged.assignedQuestionnaireIds || []),
      JSON.stringify(merged.assignedSlumIds || []),
      JSON.stringify(merged.projectSlumAssignments || {}),
    ]
  );
  return rows[0] ? rowToUser(rows[0]) : null;
}

export async function isUserBlocked(uid: string, email: string): Promise<boolean> {
  const uidCheck = await pool.query('SELECT 1 FROM deleted_users WHERE uid = $1', [uid]);
  if (uidCheck.rowCount) return true;
  const emailKey = encodeURIComponent(email.trim().toLowerCase());
  const emailCheck = await pool.query('SELECT 1 FROM deleted_user_emails WHERE email_key = $1', [
    emailKey,
  ]);
  return Boolean(emailCheck.rowCount);
}

export async function blockDeletedUser(
  uid: string,
  email: string,
  deletedBy: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  await pool.query(
    `INSERT INTO deleted_users (uid, email, deleted_by, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (uid) DO NOTHING`,
    [uid, email, deletedBy, JSON.stringify(payload)]
  );
  const emailKey = encodeURIComponent(email.trim().toLowerCase());
  await pool.query(
    `INSERT INTO deleted_user_emails (email_key, email)
     VALUES ($1, $2)
     ON CONFLICT (email_key) DO NOTHING`,
    [emailKey, email.trim().toLowerCase()]
  );
  await pool.query('DELETE FROM users WHERE id = $1', [uid]);
  await pool.query('DELETE FROM user_credentials WHERE user_id = $1', [uid]);
}
