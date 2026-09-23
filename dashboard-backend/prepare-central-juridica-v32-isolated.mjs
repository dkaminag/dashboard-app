import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const primaryDatabaseName = 'central_juridica_v32_prod';
const drDatabaseName = 'central_juridica_v32_dr';
const require = createRequire(new URL('./runtime/package.json', import.meta.url));
const { Pool } = require('pg');

function dedicatedUrl(raw, databaseName) {
  const url = new URL(raw);
  url.pathname = '/' + databaseName;
  return url.toString();
}

async function ensureDedicatedDatabase(envName, databaseName) {
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
  } finally {
    await admin.end();
  }

  const nextUrl = dedicatedUrl(baseUrl, databaseName);
  const verify = new Pool({...options, connectionString: nextUrl});
  try {
    const result = await verify.query('SELECT current_database() AS db');
    if (result.rows?.[0]?.db !== databaseName) throw new Error(envName + '_DEDICATED_DATABASE_NOT_READY');
  } finally {
    await verify.end();
  }
  process.env[envName] = nextUrl;
}

await ensureDedicatedDatabase('CJ_DATABASE_URL', primaryDatabaseName);
await ensureDedicatedDatabase('CJ_DR_DATABASE_URL', drDatabaseName);

async function ensureRuntimeSchema(envName, databaseName) {
  const databaseUrl = String(process.env[envName] || '').trim();
  if (!databaseUrl) throw new Error(envName + '_MISSING_BEFORE_SCHEMA_INIT');
  const { createStore } = await import('./runtime/src/store-factory.mjs');
  const runtime = await createStore({ databaseUrl });
  try {
    await runtime.store.ensure();
    console.log(JSON.stringify({event:'runtime-schema-ready',target:envName,database:databaseName}));
  } finally {
    if (runtime.pool) await runtime.pool.end();
  }
}

await ensureRuntimeSchema('CJ_DATABASE_URL', primaryDatabaseName);
await ensureRuntimeSchema('CJ_DR_DATABASE_URL', drDatabaseName);

const runtimeRole = 'central_juridica_v32_runtime';
const runtimePassword = String(process.env.CJ_RUNTIME_DB_PASSWORD || '').trim();
if (!/^[A-Za-z0-9_-]{40,128}$/.test(runtimePassword)) {
  throw new Error('CJ_RUNTIME_DB_PASSWORD_POLICY_FAILED');
}

function quoteLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function runtimeUrl(raw, databaseName) {
  const url = new URL(raw);
  url.pathname = '/' + databaseName;
  url.username = runtimeRole;
  url.password = runtimePassword;
  return url.toString();
}

async function ensureLeastPrivilegeRole(envName, databaseName) {
  const adminUrl = String(process.env[envName] || '').trim();
  if (!adminUrl) throw new Error(envName + '_MISSING_BEFORE_ROLE_SETUP');

  const admin = new Pool({
    connectionString: adminUrl,
    max: 1,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
    application_name: 'central-juridica-v32-role-admin',
    ssl: process.env.CJ_PG_SSL === 'true' ? { rejectUnauthorized: true } : undefined
  });

  try {
    const exists = await admin.query(
      'SELECT 1 FROM pg_roles WHERE rolname=$1',
      [runtimeRole]
    );
    if (exists.rowCount === 0) {
      await admin.query(
        'CREATE ROLE "' + runtimeRole + '" LOGIN PASSWORD ' + quoteLiteral(runtimePassword)
      );
    } else {
      await admin.query(
        'ALTER ROLE "' + runtimeRole + '" LOGIN PASSWORD ' + quoteLiteral(runtimePassword)
      );
    }

    await admin.query(
      'ALTER ROLE "' + runtimeRole + '" NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
    );
    await admin.query(
      'GRANT CONNECT, TEMPORARY ON DATABASE "' + databaseName + '" TO "' + runtimeRole + '"'
    );
    await admin.query(
      'GRANT USAGE, CREATE ON SCHEMA public TO "' + runtimeRole + '"'
    );
    await admin.query(
      'GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public TO "' + runtimeRole + '"'
    );
    await admin.query(
      'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "' + runtimeRole + '"'
    );
    await admin.query(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLES TO "' + runtimeRole + '"'
    );
    await admin.query(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO "' + runtimeRole + '"'
    );
  } finally {
    await admin.end();
  }

  const url = runtimeUrl(adminUrl, databaseName);
  const restricted = new Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
    application_name: 'central-juridica-v32-role-check',
    ssl: process.env.CJ_PG_SSL === 'true' ? { rejectUnauthorized: true } : undefined
  });

  try {
    const result = await restricted.query(
      'SELECT current_user, current_database(), rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname=current_user'
    );
    const row = result.rows?.[0] || {};
    if (row.current_user !== runtimeRole || row.current_database !== databaseName) {
      throw new Error(envName + '_RUNTIME_ROLE_BINDING_FAILED');
    }
    if (row.rolsuper || row.rolcreatedb || row.rolcreaterole || row.rolreplication || row.rolbypassrls) {
      throw new Error(envName + '_RUNTIME_ROLE_EXCESS_PRIVILEGE');
    }
  } finally {
    await restricted.end();
  }

  const { createStore } = await import('./runtime/src/store-factory.mjs');
  const runtime = await createStore({ databaseUrl: url });
  try {
    await runtime.store.ensure();
  } finally {
    if (runtime.pool) await runtime.pool.end();
  }

  console.log(JSON.stringify({
    event:'runtime-db-role-ready',
    target:envName,
    database:databaseName,
    role:runtimeRole,
    superuser:false,
    createdb:false,
    createrole:false,
    replication:false,
    bypassrls:false
  }));

  process.env[envName] = url;
}

await ensureLeastPrivilegeRole('CJ_DATABASE_URL', primaryDatabaseName);
await ensureLeastPrivilegeRole('CJ_DR_DATABASE_URL', drDatabaseName);

async function run(script) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(script + '_FAILED_' + code)));
  });
}

await run('sync-qa-user.mjs');
await run('final-drill.mjs');
console.log(JSON.stringify({event:'isolated-prod-predeploy-passed',primaryDatabase:primaryDatabaseName,drDatabase:drDatabaseName,version:'3.2.0-preview'}));
