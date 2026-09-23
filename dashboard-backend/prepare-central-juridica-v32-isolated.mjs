import { createRequire } from 'node:module';

const schema = 'central_juridica_v32_prod';
const require = createRequire(new URL('./runtime/package.json', import.meta.url));
const { Pool } = require('pg');

for (const envName of ['CJ_DATABASE_URL', 'CJ_DR_DATABASE_URL']) {
  const connectionString = String(process.env[envName] || '').trim();
  if (!connectionString) throw new Error(envName + '_MISSING');
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
    application_name: 'central-juridica-v32-schema-init',
    ssl: process.env.CJ_PG_SSL === 'true' ? { rejectUnauthorized: true } : undefined
  });
  try {
    await pool.query('CREATE SCHEMA IF NOT EXISTS ' + schema);
    const check = await pool.query(
      'SELECT schema_name FROM information_schema.schemata WHERE schema_name=$1',
      [schema]
    );
    if (check.rowCount !== 1) throw new Error(envName + '_SCHEMA_NOT_READY');
    console.log(JSON.stringify({event:'schema-ready',target:envName,schema}));
  } finally {
    await pool.end();
  }
}
