import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

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

async function run(script) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(script + '_FAILED_' + code)));
  });
}

await run('sync-qa-user.mjs');
await run('final-drill.mjs');
console.log(JSON.stringify({event:'isolated-prod-predeploy-passed',schema,version:'3.2.0-preview'}));
