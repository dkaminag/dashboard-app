import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const event = (stage, extra = {}) => console.log(JSON.stringify({ event: 'central-juridica-final-key-drill', stage, ...extra }));
const fail = (stage, extra = {}) => { event(stage, { ok: false, ...extra }); process.exit(1); };
const env = process.env;

for (const name of ['CJ_DATABASE_URL', 'CJ_DR_DATABASE_URL', 'CJ_BACKUP_KEYRING']) {
  if (!env[name]) fail('required-secret-missing', { name });
}

let productionUrl;
let drUrl;
try {
  productionUrl = new URL(env.CJ_DATABASE_URL);
  drUrl = new URL(env.CJ_DR_DATABASE_URL);
} catch {
  fail('database-url-invalid');
}

const drDatabaseName = decodeURIComponent(drUrl.pathname || '').replace(/^\//, '').toLowerCase();
if (productionUrl.href === drUrl.href) fail('dr-target-equals-production');
if (!/(^|[_-])(dr|restore)([_-]|$)/i.test(drDatabaseName)) fail('dr-target-not-explicitly-isolated');

const runtimeDir = path.resolve('runtime');
const backupScript = path.join(runtimeDir, 'scripts', 'backup.mjs');
const restoreScript = path.join(runtimeDir, 'scripts', 'restore.mjs');
if (!fs.existsSync(backupScript) || !fs.existsSync(restoreScript)) fail('backup-restore-scripts-missing');

const backupRoot = path.join('/tmp', `central-juridica-final-key-${Date.now()}`);
fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });

const requireFromRuntime = createRequire(path.join(runtimeDir, 'package.json'));
const { Pool } = requireFromRuntime('pg');
const query = async (connectionString, text, values = []) => {
  const pool = new Pool({ connectionString, max: 1 });
  try { return await pool.query(text, values); }
  finally { await pool.end(); }
};

const auditCount = async (connectionString, action) => Number((await query(
  connectionString,
  "SELECT count(*)::int AS n FROM central_juridica_audit_log WHERE payload->>'action'=$1",
  [action]
)).rows[0].n);

const runNode = (script, args = [], overrides = {}) => spawnSync(
  process.execPath,
  [script, ...args],
  {
    cwd: runtimeDir,
    env: { ...env, ...overrides },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 240000,
  }
);

const parseJsonOutput = (text, stage) => {
  try { return JSON.parse(String(text || '').trim()); }
  catch { fail(`${stage}-output-invalid`); }
};

try {
  event('preflight', { ok: true, isolatedTarget: true });

  const backupAuditBefore = await auditCount(env.CJ_DATABASE_URL, 'BACKUP_CREATED_VERIFIED');

  const backup = runNode('scripts/backup.mjs', [], { CJ_BACKUP_DIR: backupRoot });
  if (backup.status !== 0) fail('backup-command-failed', { exitCode: backup.status });
  const backupResult = parseJsonOutput(backup.stdout, 'backup');
  if (!backupResult?.ok || !backupResult?.target) fail('backup-not-verified');

  const target = path.resolve(String(backupResult.target));
  const allowedRoot = `${path.resolve(backupRoot)}${path.sep}`;
  if (!target.startsWith(allowedRoot) || !fs.existsSync(target)) fail('backup-target-invalid');

  const backupAuditAfter = await auditCount(env.CJ_DATABASE_URL, 'BACKUP_CREATED_VERIFIED');
  if (backupAuditAfter !== backupAuditBefore + 1) {
    fail('backup-audit-event-not-exactly-once', { before: backupAuditBefore, after: backupAuditAfter });
  }
  event('backup', { ok: true, verified: true, auditEventDelta: 1 });

  const restore = runNode('scripts/restore.mjs', [target], { CJ_DATABASE_URL: env.CJ_DR_DATABASE_URL });
  if (restore.status !== 0) fail('restore-command-failed', { exitCode: restore.status });
  const restoreResult = parseJsonOutput(restore.stdout, 'restore');
  if (!restoreResult?.ok) fail('restore-not-verified');

  const restoreAuditCount = await auditCount(env.CJ_DR_DATABASE_URL, 'BACKUP_RESTORE_VERIFIED');
  const sessionCount = Number((await query(env.CJ_DR_DATABASE_URL, 'SELECT count(*)::int AS n FROM central_juridica_sessions')).rows[0].n);
  const stateRows = Number((await query(env.CJ_DR_DATABASE_URL, 'SELECT count(*)::int AS n FROM central_juridica_state WHERE singleton=TRUE')).rows[0].n);
  const auditMetaRows = Number((await query(env.CJ_DR_DATABASE_URL, 'SELECT count(*)::int AS n FROM central_juridica_audit_meta')).rows[0].n);

  if (restoreAuditCount < 1) fail('restore-audit-event-missing');
  if (sessionCount !== 0) fail('sessions-restored-unexpectedly', { sessionCount });
  if (stateRows !== 1 || auditMetaRows < 1) fail('restored-core-state-invalid', { stateRows, auditMetaRows });

  event('restore', {
    ok: true,
    verified: true,
    restoreAuditPresent: true,
    sessionsRestored: false,
    stateRows,
    auditMetaRows,
  });
  event('complete', { ok: true, certificationGate: 'FINAL_KEY_BACKUP_RESTORE_PASS' });
} catch (error) {
  fail('unexpected-error', { name: error?.name || 'Error', code: error?.code || null });
}
