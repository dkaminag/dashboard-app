import path from 'node:path';
import { JsonStore } from './store.mjs';
import { PostgresStateStore } from './postgres-store.mjs';

export async function createStore({ dataFile, databaseUrl = process.env.CJ_DATABASE_URL } = {}) {
  if (!databaseUrl) return { store: new JsonStore(dataFile || path.resolve('data/db.json')), backend: 'json', pool: null };
  let pg;
  try { pg = await import('pg'); }
  catch { throw new Error('CJ_DATABASE_URL foi definido, mas o driver PostgreSQL "pg" não está instalado. Execute npm install pg antes de iniciar em modo PostgreSQL.'); }

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: Number(process.env.CJ_PG_POOL_MAX || 10),
    connectionTimeoutMillis: Number(process.env.CJ_PG_CONNECT_TIMEOUT_MS || 5000),
    idleTimeoutMillis: Number(process.env.CJ_PG_IDLE_TIMEOUT_MS || 30000),
    statement_timeout: Number(process.env.CJ_PG_STATEMENT_TIMEOUT_MS || 15000),
    application_name: process.env.CJ_PG_APP_NAME || 'central-juridica',
    ssl: process.env.CJ_PG_SSL === 'true' ? { rejectUnauthorized: true } : undefined
  });
  return { store: new PostgresStateStore(pool), backend: 'postgres', pool };
}
