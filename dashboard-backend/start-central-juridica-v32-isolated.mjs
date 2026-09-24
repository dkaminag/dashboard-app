const primaryDatabaseName = 'central_juridica_v32_prod_r2';
const drDatabaseName = 'central_juridica_v32_dr_r2';
const runtimeRole = 'central_juridica_v32_runtime';

function runtimeUrl(raw, envName, databaseName) {
  const value = String(raw || '').trim();
  const password = String(process.env.CJ_RUNTIME_DB_PASSWORD || '').trim();
  if (!value) throw new Error(envName + '_MISSING');
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(password)) {
    throw new Error('CJ_RUNTIME_DB_PASSWORD_POLICY_FAILED');
  }
  const url = new URL(value);
  if (process.env.CJ_PG_SSL === 'true') url.searchParams.set('sslmode', 'verify-full');
  url.pathname = '/' + databaseName;
  url.username = runtimeRole;
  url.password = password;
  return url.toString();
}

process.env.CJ_DATABASE_URL = runtimeUrl(
  process.env.CJ_DATABASE_URL,
  'CJ_DATABASE_URL',
  primaryDatabaseName
);
if (String(process.env.CJ_DR_DATABASE_URL || '').trim()) {
  process.env.CJ_DR_DATABASE_URL = runtimeUrl(
    process.env.CJ_DR_DATABASE_URL,
    'CJ_DR_DATABASE_URL',
    drDatabaseName
  );
}
process.env.CJ_SCHEMA_PREPARED = 'true';
delete process.env.CJ_RUNTIME_DB_PASSWORD;
delete process.env.PGOPTIONS;

await import('./start.mjs');
