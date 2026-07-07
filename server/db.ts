import './env';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getDatabaseUrl(): string {
  return (
    process.env.DATABASE_URL ||
    'postgresql://geosurvey:geosurvey@localhost:5432/eqms_geosurvey'
  );
}

function buildPoolConfig(): pg.PoolConfig {
  const connectionString = getDatabaseUrl();
  const config: pg.PoolConfig = {
    connectionString,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
  if (process.env.DATABASE_SSL === 'true') {
    config.ssl = { rejectUnauthorized: false };
  }
  return config;
}

export const pool = new pg.Pool(buildPoolConfig());

export async function initDb(): Promise<void> {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(schema);
}
