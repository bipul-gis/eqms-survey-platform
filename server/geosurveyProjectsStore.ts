import { pool } from './db';

export interface GeosurveyProjectRecord {
  projectId: string;
  projectCode: string;
  projectName: string;
  managerName?: string;
  isActive: boolean;
  projectPayload: Record<string, unknown>;
}

const DEFAULT_GEOSPATIAL_PROJECT_CODE = '20612601105';
const DEFAULT_GEOSPATIAL_PROJECT_NAME =
  'Consultancy services GPS Technology Assisted Mapping and Listing Exercise';

function isDefaultGeospatialProject(project: { code?: unknown; name?: unknown }): boolean {
  const code = String(project.code || '').trim();
  const name = String(project.name || '').trim().toLowerCase();
  return (
    code === DEFAULT_GEOSPATIAL_PROJECT_CODE ||
    name === DEFAULT_GEOSPATIAL_PROJECT_NAME.toLowerCase()
  );
}

/**
 * Normalize segments without overwriting an explicit admin choice.
 * Default: known GPS mapping project → geospatial on; all others → off
 * until the admin enables it in Project Picker.
 */
function normalizeProjectPayload(project: { [key: string]: unknown }) {
  const existingSegments =
    project.segments && typeof project.segments === 'object'
      ? (project.segments as Record<string, unknown>)
      : {};

  const geospatial =
    typeof existingSegments.geospatial === 'boolean'
      ? existingSegments.geospatial
      : isDefaultGeospatialProject(project);

  return {
    ...project,
    segments: {
      ...existingSegments,
      geospatial,
      questionnaire: existingSegments.questionnaire !== false,
    },
  };
}

function rowToRecord(row: Record<string, unknown>): GeosurveyProjectRecord {
  const normalizedPayload = normalizeProjectPayload(
    ((row.project_payload as Record<string, unknown>) || {}) as { [key: string]: unknown }
  );
  return {
    projectId: row.project_id as string,
    projectCode: (row.project_code as string) || '',
    projectName: (row.project_name as string) || '',
    managerName: (row.manager_name as string) || undefined,
    isActive: row.is_active !== false,
    projectPayload: normalizedPayload,
  };
}

export async function listActiveGeosurveyProjects(): Promise<GeosurveyProjectRecord[]> {
  const { rows } = await pool.query(
    `SELECT * FROM geosurvey_projects WHERE is_active = TRUE ORDER BY project_name, project_code`
  );
  return rows.map((row) => rowToRecord(row));
}

export async function getGeosurveyProject(
  projectId: string
): Promise<GeosurveyProjectRecord | null> {
  const { rows } = await pool.query(`SELECT * FROM geosurvey_projects WHERE project_id = $1`, [
    projectId,
  ]);
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export async function activateGeosurveyProject(project: {
  id: string;
  code?: string;
  name?: string;
  manager?: string;
  [key: string]: unknown;
}): Promise<GeosurveyProjectRecord> {
  const existing = await getGeosurveyProject(project.id);
  let toSave: { [key: string]: unknown } = { ...project };

  // Preserve admin segment toggles when re-activating from MIS.
  if (existing?.projectPayload) {
    const prev = existing.projectPayload as { [key: string]: unknown };
    const prevSeg =
      prev.segments && typeof prev.segments === 'object'
        ? (prev.segments as Record<string, unknown>)
        : {};
    const nextSeg =
      project.segments && typeof project.segments === 'object'
        ? (project.segments as Record<string, unknown>)
        : {};
    toSave = {
      ...prev,
      ...project,
      segments: {
        ...prevSeg,
        ...nextSeg,
        geospatial:
          typeof nextSeg.geospatial === 'boolean'
            ? nextSeg.geospatial
            : typeof prevSeg.geospatial === 'boolean'
              ? prevSeg.geospatial
              : undefined,
        questionnaire:
          typeof nextSeg.questionnaire === 'boolean'
            ? nextSeg.questionnaire
            : prevSeg.questionnaire !== false,
      },
    };
  }

  const normalizedProject = normalizeProjectPayload(toSave);
  const { rows } = await pool.query(
    `INSERT INTO geosurvey_projects (
      project_id, project_code, project_name, manager_name, is_active, project_payload, updated_at
    ) VALUES ($1, $2, $3, $4, TRUE, $5, NOW())
    ON CONFLICT (project_id) DO UPDATE SET
      project_code = EXCLUDED.project_code,
      project_name = EXCLUDED.project_name,
      manager_name = EXCLUDED.manager_name,
      is_active = TRUE,
      project_payload = EXCLUDED.project_payload,
      updated_at = NOW()
    RETURNING *`,
    [
      project.id,
      String(project.code || ''),
      String(project.name || ''),
      project.manager ? String(project.manager) : null,
      JSON.stringify(normalizedProject),
    ]
  );
  return rowToRecord(rows[0]);
}

export async function updateGeosurveyProjectSegments(
  projectId: string,
  segments: { geospatial?: boolean; questionnaire?: boolean }
): Promise<GeosurveyProjectRecord | null> {
  const existing = await getGeosurveyProject(projectId);
  if (!existing) return null;

  const prev = (existing.projectPayload || {}) as { [key: string]: unknown };
  const prevSegments =
    prev.segments && typeof prev.segments === 'object'
      ? (prev.segments as Record<string, unknown>)
      : {};

  const nextPayload = normalizeProjectPayload({
    ...prev,
    id: existing.projectId,
    code: existing.projectCode,
    name: existing.projectName,
    segments: {
      ...prevSegments,
      ...(typeof segments.geospatial === 'boolean' ? { geospatial: segments.geospatial } : {}),
      ...(typeof segments.questionnaire === 'boolean'
        ? { questionnaire: segments.questionnaire }
        : {}),
    },
  });

  const { rows } = await pool.query(
    `UPDATE geosurvey_projects
     SET project_payload = $2, updated_at = NOW()
     WHERE project_id = $1
     RETURNING *`,
    [projectId, JSON.stringify(nextPayload)]
  );
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export async function deactivateGeosurveyProject(projectId: string): Promise<void> {
  await pool.query(
    `UPDATE geosurvey_projects
     SET is_active = FALSE, updated_at = NOW()
     WHERE project_id = $1`,
    [projectId]
  );
}
