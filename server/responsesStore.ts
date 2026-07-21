import { randomUUID } from 'crypto';
import { pool } from './db';

export async function listResponses(filters: {
  questionnaireId?: string;
  respondentId?: string;
  status?: string;
}): Promise<Record<string, unknown>[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.questionnaireId) {
    params.push(filters.questionnaireId);
    clauses.push(`questionnaire_id = $${params.length}`);
  }
  if (filters.respondentId) {
    params.push(filters.respondentId);
    clauses.push(`respondent_id = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    clauses.push(`status = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT payload FROM questionnaire_responses ${where} ORDER BY updated_at DESC`,
    params
  );
  return rows.map((r) => r.payload as Record<string, unknown>);
}

export async function upsertResponse(
  id: string | undefined,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const rid = id || randomUUID();
  const questionnaireId = String(payload.questionnaireId || '');
  const respondentId = String(payload.respondentId || '');
  const status = String(payload.status || 'draft');
  const nowIso = new Date().toISOString();
  const full: Record<string, unknown> = {
    ...payload,
    id: rid,
    updatedAt: nowIso
  };
  // Guarantee a submit timestamp when status flips to submitted (covers
  // clients that omit it, and keeps server clock as the source of truth
  // when the field is missing).
  if (status === 'submitted' && !full.submittedAt) {
    full.submittedAt = nowIso;
  }
  await pool.query(
    `INSERT INTO questionnaire_responses (id, questionnaire_id, respondent_id, status, payload, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (id) DO UPDATE SET
       questionnaire_id = EXCLUDED.questionnaire_id,
       respondent_id = EXCLUDED.respondent_id,
       status = EXCLUDED.status,
       payload = EXCLUDED.payload,
       updated_at = NOW()`,
    [rid, questionnaireId, respondentId, status, JSON.stringify(full)]
  );
  return full;
}

export async function deleteResponse(id: string): Promise<void> {
  await pool.query('DELETE FROM questionnaire_responses WHERE id = $1', [id]);
}
