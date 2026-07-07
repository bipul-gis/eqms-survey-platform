import { randomUUID } from 'crypto';
import { pool } from './db';

export async function listQuestionnaires(projectId?: string): Promise<Record<string, unknown>[]> {
  const { rows } = projectId
    ? await pool.query(
        'SELECT payload FROM questionnaires WHERE project_id = $1 ORDER BY updated_at DESC',
        [projectId]
      )
    : await pool.query('SELECT payload FROM questionnaires ORDER BY updated_at DESC');
  return rows.map((r) => r.payload as Record<string, unknown>);
}

export async function getQuestionnaire(id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query('SELECT payload FROM questionnaires WHERE id = $1', [id]);
  return rows[0] ? (rows[0].payload as Record<string, unknown>) : null;
}

export async function upsertQuestionnaire(
  id: string | undefined,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const qid = id || randomUUID();
  const projectId = String(payload.projectId || '');
  const full = {
    ...payload,
    id: qid,
    updatedAt: new Date().toISOString(),
    createdAt: payload.createdAt || new Date().toISOString(),
  };
  await pool.query(
    `INSERT INTO questionnaires (id, project_id, payload, created_at, updated_at)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()), NOW())
     ON CONFLICT (id) DO UPDATE SET
       project_id = EXCLUDED.project_id,
       payload = EXCLUDED.payload,
       updated_at = NOW()`,
    [qid, projectId, JSON.stringify(full), full.createdAt as string]
  );
  return full;
}

export async function deleteQuestionnaire(id: string): Promise<void> {
  await pool.query('DELETE FROM questionnaires WHERE id = $1', [id]);
}

export async function countQuestionnairesByProject(): Promise<Record<string, number>> {
  const { rows } = await pool.query(
    'SELECT project_id, COUNT(*)::int AS count FROM questionnaires GROUP BY project_id'
  );
  const out: Record<string, number> = {};
  for (const row of rows) {
    out[row.project_id as string] = row.count as number;
  }
  return out;
}
