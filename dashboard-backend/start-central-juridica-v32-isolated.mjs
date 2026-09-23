const primaryDatabaseName = 'central_juridica_v32_prod';
const drDatabaseName = 'central_juridica_v32_dr';

function dedicatedUrl(raw, envName, databaseName) {
  const value = String(raw || '').trim();
  if (!value) throw new Error(envName + '_MISSING');
  const url = new URL(value);
  url.pathname = '/' + databaseName;
  return url.toString();
}

process.env.CJ_DATABASE_URL = dedicatedUrl(process.env.CJ_DATABASE_URL, 'CJ_DATABASE_URL', primaryDatabaseName);
if (String(process.env.CJ_DR_DATABASE_URL || '').trim()) {
  process.env.CJ_DR_DATABASE_URL = dedicatedUrl(process.env.CJ_DR_DATABASE_URL, 'CJ_DR_DATABASE_URL', drDatabaseName);
}
delete process.env.PGOPTIONS;

await import('./start.mjs');
