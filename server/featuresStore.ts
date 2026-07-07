import { randomUUID } from 'crypto';
import { pool } from './db';

function extractFeatureIndexFields(payload: Record<string, unknown>) {
  const attrs = (payload.attributes as Record<string, unknown>) || {};
  return {
    type: String(payload.type || 'point'),
    status: String(payload.status || 'pending'),
    createdByUid: (payload.createdByUid as string) || null,
    createdBy: (payload.createdBy as string) || null,
    taskWard: attrs.__taskWard != null ? String(attrs.__taskWard) : null,
    wardName:
      attrs.Ward_Name != null
        ? String(attrs.Ward_Name)
        : attrs.WARDNAME != null
          ? String(attrs.WARDNAME)
          : null,
  };
}

export async function listFeatures(filters: {
  role: 'admin' | 'enumerator';
  userUid?: string;
  userEmail?: string;
  assignedWards?: string[];
}): Promise<Record<string, unknown>[]> {
  if (filters.role === 'admin') {
    const { rows } = await pool.query('SELECT payload FROM features ORDER BY updated_at DESC');
    return rows.map((r) => r.payload as Record<string, unknown>);
  }

  const wards = filters.assignedWards || [];
  if (wards.length > 0) {
    const wardValues = [...new Set(wards.map((w) => String(w).trim()).filter(Boolean))];
    const { rows } = await pool.query(
      `SELECT payload FROM features
       WHERE task_ward = ANY($1::text[]) OR ward_name = ANY($1::text[])
          OR created_by_uid = $2 OR created_by = $3
       ORDER BY updated_at DESC`,
      [wardValues, filters.userUid ?? null, filters.userEmail ?? null]
    );
    return rows.map((r) => r.payload as Record<string, unknown>);
  }

  const { rows } = await pool.query(
    `SELECT payload FROM features
     WHERE created_by_uid = $1 OR created_by = $2
     ORDER BY updated_at DESC`,
    [filters.userUid ?? null, filters.userEmail ?? null]
  );
  return rows.map((r) => r.payload as Record<string, unknown>);
}

export async function upsertFeature(
  id: string | undefined,
  payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const featureId = id || randomUUID();
  const full = { ...payload, id: featureId, updatedAt: new Date().toISOString() };
  const idx = extractFeatureIndexFields(full);
  await pool.query(
    `INSERT INTO features (id, payload, type, status, created_by_uid, created_by, task_ward, ward_name, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (id) DO UPDATE SET
       payload = EXCLUDED.payload,
       type = EXCLUDED.type,
       status = EXCLUDED.status,
       created_by_uid = EXCLUDED.created_by_uid,
       created_by = EXCLUDED.created_by,
       task_ward = EXCLUDED.task_ward,
       ward_name = EXCLUDED.ward_name,
       updated_at = NOW()`,
    [
      featureId,
      JSON.stringify(full),
      idx.type,
      idx.status,
      idx.createdByUid,
      idx.createdBy,
      idx.taskWard,
      idx.wardName,
    ]
  );
  return full;
}

export async function deleteFeature(id: string): Promise<void> {
  await pool.query('DELETE FROM features WHERE id = $1', [id]);
}

export async function bulkUpsertFeatures(items: Record<string, unknown>[]): Promise<number> {
  let count = 0;
  for (const item of items) {
    const id = String(item.id || randomUUID());
    await upsertFeature(id, { ...item, id });
    count += 1;
  }
  return count;
}

export async function bulkDeleteFeatures(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const { rowCount } = await pool.query('DELETE FROM features WHERE id = ANY($1::text[])', [ids]);
  return rowCount ?? 0;
}
