import './env';
import { Client } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const adminUrl = process.env.PG_ADMIN_URL || 'postgresql://postgres@localhost:5432/postgres';
  const dbName = process.env.GEOSURVEY_DB_NAME || 'eqms_geosurvey';
  const dbUser = process.env.GEOSURVEY_DB_USER || 'geosurvey';
  const dbPassword = process.env.GEOSURVEY_DB_PASSWORD || 'eqms.MIS.12@';

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();

  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!exists.rowCount) {
    await admin.query(`CREATE DATABASE "${dbName}"`);
    console.log(`Created database ${dbName}`);
  }

  const roleExists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [dbUser]);
  if (!roleExists.rowCount) {
    await admin.query(`CREATE USER "${dbUser}" WITH PASSWORD '${dbPassword.replace(/'/g, "''")}'`);
    console.log(`Created user ${dbUser}`);
  }

  await admin.query(`GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${dbUser}"`);
  await admin.end();

  const appUrl =
    process.env.DATABASE_URL ||
    `postgresql://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPassword)}@localhost:5432/${dbName}`;
  const client = new Client({ connectionString: appUrl });
  await client.connect();
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await client.query(schema);
  await client.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO "${dbUser}"`);
  await client.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO "${dbUser}"`);
  await client.end();
  console.log('GeoSurvey database ready:', dbName);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
