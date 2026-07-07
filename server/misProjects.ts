import pg from 'pg';

interface MisProject {
  id: string;
  code: string;
  name: string;
  manager?: string;
  managerId?: string;
  status?: string;
}

function getMisDatabaseUrl(): string {
  return (
    process.env.MIS_DATABASE_URL ||
    'postgresql://eqms:eqms.MIS.12%40@127.0.0.1:5432/eqms-mis'
  );
}

const misPool = new pg.Pool({
  connectionString: getMisDatabaseUrl(),
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export async function fetchMisProjects(): Promise<MisProject[]> {
  const { rows } = await misPool.query(
    `SELECT value
     FROM mis_collections
     WHERE key = 'eqms_projects'
     LIMIT 1`
  );
  const value = rows[0]?.value;
  if (!Array.isArray(value)) return [];
  return value as MisProject[];
}

export function misProjectToGeosurvey(p: MisProject) {
  const active = p.status === 'Ongoing' || p.status === 'Payment Pending';
  return {
    id: p.id,
    name: p.name,
    code: p.code,
    description: p.manager ? `PM: ${p.manager}` : '',
    segments: { geospatial: true, questionnaire: true },
    isActive: active,
    misStatus: p.status,
    manager: p.manager,
    managerId: p.managerId,
  };
}
