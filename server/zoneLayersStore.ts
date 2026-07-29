import { randomUUID } from 'crypto';
import { pool } from './db';

export interface ZoneLayerRecord {
  id: string;
  projectId: string;
  name: string;
  assignmentField: string | null;
  labelField: string | null;
  attributeFields: string[];
  featureCount: number;
  strictGeofence: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ZonePolygonRecord {
  id: string;
  layerId: string;
  projectId: string;
  assignValue: string | null;
  properties: Record<string, unknown>;
  geometry: Record<string, unknown>;
  updatedAt: string;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter(Boolean);
}

function rowToLayer(row: Record<string, unknown>): ZoneLayerRecord {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    name: (row.name as string) || 'Zones',
    assignmentField: (row.assignment_field as string) || null,
    labelField: (row.label_field as string) || null,
    attributeFields: asStringArray(row.attribute_fields),
    featureCount: Number(row.feature_count) || 0,
    strictGeofence: row.strict_geofence !== false,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function rowToPolygon(row: Record<string, unknown>): ZonePolygonRecord {
  return {
    id: row.id as string,
    layerId: row.layer_id as string,
    projectId: row.project_id as string,
    assignValue: (row.assign_value as string) || null,
    properties: (row.properties as Record<string, unknown>) || {},
    geometry: (row.geometry as Record<string, unknown>) || {},
    updatedAt: row.updated_at as string,
  };
}

export async function listZoneLayers(projectId?: string): Promise<ZoneLayerRecord[]> {
  if (projectId) {
    const { rows } = await pool.query(
      `SELECT * FROM zone_layers WHERE project_id = $1 ORDER BY updated_at DESC`,
      [projectId]
    );
    return rows.map(rowToLayer);
  }
  const { rows } = await pool.query(`SELECT * FROM zone_layers ORDER BY updated_at DESC`);
  return rows.map(rowToLayer);
}

export async function getZoneLayer(id: string): Promise<ZoneLayerRecord | null> {
  const { rows } = await pool.query(`SELECT * FROM zone_layers WHERE id = $1`, [id]);
  return rows[0] ? rowToLayer(rows[0]) : null;
}

export async function listZonePolygons(opts: {
  layerId?: string;
  projectId?: string;
  assignValues?: string[];
}): Promise<ZonePolygonRecord[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.layerId) {
    params.push(opts.layerId);
    clauses.push(`layer_id = $${params.length}`);
  }
  if (opts.projectId) {
    params.push(opts.projectId);
    clauses.push(`project_id = $${params.length}`);
  }
  if (opts.assignValues && opts.assignValues.length > 0) {
    params.push(opts.assignValues.map((v) => String(v).trim().toLowerCase()));
    clauses.push(`LOWER(TRIM(assign_value)) = ANY($${params.length}::text[])`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM zone_polygons ${where} ORDER BY assign_value NULLS LAST, id`,
    params
  );
  return rows.map(rowToPolygon);
}

export async function distinctAssignValues(layerId: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT assign_value AS v FROM zone_polygons
     WHERE layer_id = $1 AND assign_value IS NOT NULL AND TRIM(assign_value) <> ''
     ORDER BY v`,
    [layerId]
  );
  return rows.map((r) => String(r.v));
}

export async function createOrReplaceZoneLayer(input: {
  id?: string;
  projectId: string;
  name: string;
  assignmentField?: string | null;
  labelField?: string | null;
  attributeFields: string[];
  strictGeofence?: boolean;
  polygons: Array<{
    id?: string;
    assignValue?: string | null;
    properties: Record<string, unknown>;
    geometry: Record<string, unknown>;
  }>;
}): Promise<{ layer: ZoneLayerRecord; polygons: ZonePolygonRecord[] }> {
  const layerId = input.id || randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Replace polygons for this project layer: delete existing layers for project if replacing by id,
    // or create fresh. Admin import typically replaces the project's active layer.
    if (input.id) {
      await client.query(`DELETE FROM zone_polygons WHERE layer_id = $1`, [layerId]);
    } else {
      // One primary layer per project for v1 — drop previous layers on fresh import.
      await client.query(`DELETE FROM zone_layers WHERE project_id = $1`, [input.projectId]);
    }

    await client.query(
      `INSERT INTO zone_layers (
         id, project_id, name, assignment_field, label_field, attribute_fields, feature_count, strict_geofence, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         assignment_field = EXCLUDED.assignment_field,
         label_field = EXCLUDED.label_field,
         attribute_fields = EXCLUDED.attribute_fields,
         feature_count = EXCLUDED.feature_count,
         strict_geofence = EXCLUDED.strict_geofence,
         updated_at = NOW()`,
      [
        layerId,
        input.projectId,
        input.name || 'Zones',
        input.assignmentField ?? null,
        input.labelField ?? null,
        JSON.stringify(input.attributeFields || []),
        input.polygons.length,
        input.strictGeofence !== false,
      ]
    );

    const saved: ZonePolygonRecord[] = [];
    for (const p of input.polygons) {
      const pid = p.id || randomUUID();
      const { rows } = await client.query(
        `INSERT INTO zone_polygons (id, layer_id, project_id, assign_value, properties, geometry, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING *`,
        [
          pid,
          layerId,
          input.projectId,
          p.assignValue ?? null,
          JSON.stringify(p.properties || {}),
          JSON.stringify(p.geometry),
        ]
      );
      saved.push(rowToPolygon(rows[0]));
    }

    await client.query('COMMIT');
    const layer = await getZoneLayer(layerId);
    if (!layer) throw new Error('Failed to load saved zone layer');
    return { layer, polygons: saved };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function updateZoneLayerMeta(
  id: string,
  patch: {
    name?: string;
    assignmentField?: string | null;
    labelField?: string | null;
    strictGeofence?: boolean;
  }
): Promise<ZoneLayerRecord | null> {
  const existing = await getZoneLayer(id);
  if (!existing) return null;
  const name = patch.name !== undefined ? patch.name : existing.name;
  const assignmentField =
    patch.assignmentField !== undefined ? patch.assignmentField : existing.assignmentField;
  const labelField = patch.labelField !== undefined ? patch.labelField : existing.labelField;
  const strictGeofence =
    patch.strictGeofence !== undefined ? patch.strictGeofence : existing.strictGeofence;

  // Recompute assign_value on polygons when assignment field changes.
  if (assignmentField !== existing.assignmentField) {
    const polys = await listZonePolygons({ layerId: id });
    for (const p of polys) {
      const raw = assignmentField ? p.properties[assignmentField] : null;
      const assignValue =
        raw === null || raw === undefined || String(raw).trim() === ''
          ? null
          : String(raw).trim();
      await pool.query(
        `UPDATE zone_polygons SET assign_value = $2, updated_at = NOW() WHERE id = $1`,
        [p.id, assignValue]
      );
    }
  }

  const { rows } = await pool.query(
    `UPDATE zone_layers SET
       name = $2, assignment_field = $3, label_field = $4, strict_geofence = $5, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, name, assignmentField, labelField, strictGeofence]
  );
  return rows[0] ? rowToLayer(rows[0]) : null;
}

export async function deleteZoneLayer(id: string): Promise<void> {
  await pool.query(`DELETE FROM zone_layers WHERE id = $1`, [id]);
}
