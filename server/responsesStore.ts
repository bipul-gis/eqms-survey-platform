import { randomUUID } from 'crypto';
import { pool } from './db';

/**
 * Strip embedded photo dataUrls from answer payloads for list/detail screens.
 * Keeps fileName / mime / source metadata so the UI still shows "photo.jpg".
 * Full payloads (with images) are only needed for CSV/SHP export.
 */
const SLIM_PAYLOAD_SQL = `jsonb_set(
  payload - 'responses',
  '{responses}',
  (
    SELECT coalesce(jsonb_object_agg(key,
      CASE
        WHEN jsonb_typeof(value) = 'string' AND left(value #>> '{}', 10) = 'data:image'
          THEN jsonb_build_object('_photo', true, 'fileName', 'photo.jpg', 'hasPhoto', true)
        WHEN jsonb_typeof(value) = 'object' AND (value ? 'dataUrl')
          THEN (value - 'dataUrl') || jsonb_build_object('hasPhoto', true)
        ELSE value
      END
    ), '{}'::jsonb)
    FROM jsonb_each(coalesce(payload->'responses', '{}'::jsonb)) AS e(key, value)
  )
)`;

export async function listResponses(filters: {
  questionnaireId?: string;
  respondentId?: string;
  status?: string;
  projectId?: string;
  /** When true, strip base64 photo blobs (~100× smaller / faster). */
  slim?: boolean;
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
  if (filters.projectId) {
    params.push(filters.projectId);
    clauses.push(
      `questionnaire_id IN (SELECT id FROM questionnaires WHERE project_id = $${params.length})`
    );
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const selectExpr = filters.slim ? `${SLIM_PAYLOAD_SQL} AS payload` : 'payload';
  const { rows } = await pool.query(
    `SELECT ${selectExpr} FROM questionnaire_responses ${where} ORDER BY updated_at DESC`,
    params
  );
  return rows.map((r) => r.payload as Record<string, unknown>);
}

export async function getResponseById(
  id: string,
  opts?: { slim?: boolean }
): Promise<Record<string, unknown> | null> {
  const selectExpr = opts?.slim ? `${SLIM_PAYLOAD_SQL} AS payload` : 'payload';
  const { rows } = await pool.query(
    `SELECT ${selectExpr} FROM questionnaire_responses WHERE id = $1`,
    [id]
  );
  return rows[0] ? (rows[0].payload as Record<string, unknown>) : null;
}

export type ResponseLocationRow = {
  id: string;
  questionnaireId: string;
  status: string;
  respondentName?: string;
  respondentEmail?: string;
  submittedAt?: unknown;
  lat: number;
  lng: number;
  accuracy?: number;
  capturedAt?: unknown;
  ward?: string;
};

/**
 * Slim map-layer query: GPS pins only (no full answer payloads).
 * Prefer submissionLocation; fall back to location. Coerce numeric strings.
 */
export async function listResponseLocations(filters: {
  projectId?: string;
  respondentId?: string;
}): Promise<ResponseLocationRow[]> {
  const clauses: string[] = [
    `(
       (payload->'submissionLocation'->>'lat') IS NOT NULL
       OR (payload->'location'->>'lat') IS NOT NULL
     )`,
  ];
  const params: unknown[] = [];
  if (filters.projectId) {
    params.push(filters.projectId);
    clauses.push(
      `questionnaire_id IN (SELECT id FROM questionnaires WHERE project_id = $${params.length})`
    );
  }
  if (filters.respondentId) {
    params.push(filters.respondentId);
    clauses.push(`respondent_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT
       id,
       questionnaire_id,
       status,
       payload->>'respondentName' AS respondent_name,
       payload->>'respondentEmail' AS respondent_email,
       payload->'submittedAt' AS submitted_at,
       payload->'submissionLocation' AS submission_location,
       payload->'location' AS location
     FROM questionnaire_responses
     WHERE ${clauses.join(' AND ')}
     ORDER BY updated_at DESC`,
    params
  );

  const out: ResponseLocationRow[] = [];
  for (const row of rows) {
    const sub = row.submission_location as
      | { lat?: unknown; lng?: unknown; accuracy?: unknown; capturedAt?: unknown }
      | null;
    const loc = row.location as
      | { lat?: unknown; lng?: unknown; ward?: unknown }
      | null;
    const latRaw = sub?.lat ?? loc?.lat;
    const lngRaw = sub?.lng ?? loc?.lng;
    const lat = typeof latRaw === 'number' ? latRaw : Number(latRaw);
    const lng = typeof lngRaw === 'number' ? lngRaw : Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const accuracy =
      typeof sub?.accuracy === 'number'
        ? sub.accuracy
        : Number.isFinite(Number(sub?.accuracy))
          ? Number(sub?.accuracy)
          : undefined;
    out.push({
      id: String(row.id),
      questionnaireId: String(row.questionnaire_id || ''),
      status: String(row.status || 'draft'),
      respondentName: row.respondent_name ? String(row.respondent_name) : undefined,
      respondentEmail: row.respondent_email ? String(row.respondent_email) : undefined,
      submittedAt: row.submitted_at ?? undefined,
      lat,
      lng,
      accuracy,
      capturedAt: sub?.capturedAt,
      ward: typeof loc?.ward === 'string' ? loc.ward : undefined,
    });
  }
  return out;
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
