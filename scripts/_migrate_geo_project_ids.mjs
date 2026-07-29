import pg from 'pg';
const url = process.env.DATABASE_URL || 'postgresql://geosurvey:eqms.GEOSURVEY.12%40@127.0.0.1:15432/eqms-geosurvey';
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_geospatial_project_ids JSONB NOT NULL DEFAULT '[]'::jsonb`);
console.log('Column added');
// Backfill: users with zone assignments get those projects as geospatial entitlements
const { rows } = await client.query(`SELECT id, project_zone_assignments FROM users WHERE role = 'enumerator'`);
for (const row of rows) {
  const pza = row.project_zone_assignments || {};
  const projectIds = Object.keys(pza).filter(k => Array.isArray(pza[k]) && pza[k].length > 0);
  if (projectIds.length > 0) {
    await client.query(`UPDATE users SET assigned_geospatial_project_ids = $2 WHERE id = $1`, [row.id, JSON.stringify(projectIds)]);
    console.log(`  backfilled ${row.id} → ${JSON.stringify(projectIds)}`);
  }
}
console.log('Done');
await client.end();
