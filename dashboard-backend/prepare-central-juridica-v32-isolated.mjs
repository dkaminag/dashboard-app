import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const databaseName = 'central_juridica_v32_prod';
const require = createRequire(new URL('./runtime/package.json', import.meta.url));
const { Pool } = require('pg');

function dedicatedUrl(raw) {
  const url = new URL(raw);
  url.pathname = '/' + databaseName;
  return url.toString();
}

async function ensureDedicatedDatabase(envName) {
  const baseUrl = String(process.env[envName] || '').trim();
  if (!baseUrl) throw new Error(envName + '_MISSING');
  const options = {
    connectionString: baseUrl,
    max: 1,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
    application_name: 'central-juridica-v32-db-init',
    ssl: process.env.CJ_PG_SSL === 'true' ? { rejectUnauthorized: true } : undefined
  };
  const admin = new Pool(options);
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [databaseName]);
    if (exists.rowCount === 0) {
      await admin.query('CREATE DATABASE "' + databaseName + '"');
      console.log(JSON.stringify({event:'database-created',target:envName,database:databaseName}));
    } else {
      console.log(JSON.stringify({event:'database-exists',target:envName,database:databaseName}));
    }
  } finally { await admin.end(); }

  const nextUrl = dedicatedUrl(baseUrl);
  const verify = new Pool({...options, connectionString: nextUrl});
  try {
    const result = await verify.query('SELECT current_database() AS db');
    if (result.rows?.[0]?.db !== databaseName) throw new Error(envName + '_DEDICATED_DATABASE_NOT_READY');
  } finally { await verify.end(); }
  process.env[envName] = nextUrl;
}

await ensureDedicatedDatabase('CJ_DATABASE_URL');
await ensureDedicatedDatabase('CJ_DR_DATABASE_URL');

async function run(script) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio:'inherit', env:process.env });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(script + '_FAILED_' + code)));
  });
}
await run('sync-qa-user.mjs');
await run('final-drill.mjs');
console.log(JSON.stringify({event:'isolated-prod-predeploy-passed',database:databaseName,version:'3.2.0-preview'}));
