import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStore } from './runtime/src/store-factory.mjs';
import { createBackup, verifyBackup, restoreBackup } from './runtime/src/backup.mjs';
import { verifyAuditChain } from './runtime/src/audit-integrity.mjs';

function fail(code, detail = {}) {
  console.error(JSON.stringify({ ok: false, gate: 'FINAL_KEY_BACKUP_RESTORE', code, ...detail }));
  process.exit(1);
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
function digest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }
function dbIdentity(raw) {
  const u = new URL(raw);
  return `${u.hostname.toLowerCase()}:${u.port || '5432'}${u.pathname}`;
}
function stateForCompare(state) {
  const copy = structuredClone(state);
  copy.auditLog = [];
  copy.auditMeta = {};
  copy.sessions = [];
  copy.idempotency = {};
  return copy;
}
function docDigestList(snapshot) {
  return (snapshot.documents || []).map(d => ({
    documentId: String(d.documentId),
    storedSha256: String(d.storedSha256),
    payloadSha256: crypto.createHash('sha256').update(d.payload).digest('hex')
  })).sort((a,b) => a.documentId.localeCompare(b.documentId));
}

const sourceUrl = process.env.CJ_DATABASE_URL;
const drUrl = process.env.CJ_DR_DATABASE_URL;
if (!sourceUrl) fail('SOURCE_DATABASE_MISSING');
if (!drUrl) fail('DR_DATABASE_MISSING');
if (!process.env.CJ_BACKUP_KEYRING) fail('BACKUP_KEYRING_MISSING');
if (!process.env.CJ_AUDIT_KEYRING) fail('AUDIT_KEYRING_MISSING');
if (dbIdentity(sourceUrl) === dbIdentity(drUrl)) fail('DR_NOT_ISOLATED');

const backupRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cj-final-key-drill-'));
let source = null;
let dr = null;
try {
  source = await createStore({ databaseUrl: sourceUrl });
  dr = await createStore({ databaseUrl: drUrl });
  if (source.backend !== 'postgres' || dr.backend !== 'postgres') fail('POSTGRES_REQUIRED');
  await source.store.ensure();
  await dr.store.ensure();

  const sourceBefore = await source.store.exportSnapshot();
  const sourceStateDigest = digest(stateForCompare(sourceBefore.state));
  const sourceDocsDigest = digest(docDigestList(sourceBefore));

  const backup = await createBackup({
    store: source.store,
    documentDir: path.join(backupRoot, 'unused-source-docs'),
    backupRoot,
    backend: 'postgres'
  });
  const verified = await verifyBackup(backup.target);
  if (!verified.ok) fail('BACKUP_VERIFY_FAILED', { errors: verified.errors });
  if (verified.manifest?.version !== 3) fail('BACKUP_VERSION_UNEXPECTED', { version: verified.manifest?.version ?? null });
  if (!verified.manifest?.crypto?.keyId) fail('BACKUP_KEY_ID_MISSING');

  await source.store.appendAudit(
    'BACKUP_CREATED_VERIFIED', 'backup', path.basename(backup.target), 'final-key-drill',
    { backend: 'postgres', manifestVersion: verified.manifest.version, documents: verified.manifest.documents?.length || 0 }
  );
  const sourceAudit = await source.store.readAuditState();
  const sourceAuditVerify = verifyAuditChain(sourceAudit, source.store.auditKeyring);
  if (!sourceAuditVerify.ok) fail('SOURCE_AUDIT_INVALID_AFTER_BACKUP_EVENT', { errors: sourceAuditVerify.errors.map(e => e.code || String(e)) });

  const restored = await restoreBackup({
    store: dr.store,
    documentDir: path.join(backupRoot, 'unused-dr-docs'),
    target: backup.target,
    backend: 'postgres'
  });
  if (!restored?.ok || restored.sessionsRevoked !== true) fail('DR_RESTORE_FAILED');

  await dr.store.appendAudit(
    'BACKUP_RESTORE_VERIFIED', 'backup', path.basename(backup.target), 'final-key-drill',
    { backend: 'postgres', restoredDocuments: restored.restoredDocuments, restoredVersion: restored.restoredVersion }
  );

  const drAfter = await dr.store.exportSnapshot();
  const drStateDigest = digest(stateForCompare(drAfter.state));
  const drDocsDigest = digest(docDigestList(drAfter));
  if (sourceStateDigest !== drStateDigest) fail('RESTORED_STATE_MISMATCH');
  if (sourceDocsDigest !== drDocsDigest) fail('RESTORED_DOCUMENTS_MISMATCH');

  const sessionCount = Number((await dr.pool.query('SELECT count(*)::int AS n FROM central_juridica_sessions')).rows?.[0]?.n || 0);
  if (sessionCount !== 0) fail('SESSIONS_RESTORED', { sessionCount });

  const drAudit = await dr.store.readAuditState();
  const drAuditVerify = verifyAuditChain(drAudit, dr.store.auditKeyring);
  if (!drAuditVerify.ok) fail('DR_AUDIT_INVALID', { errors: drAuditVerify.errors.map(e => e.code || String(e)) });

  const sourceEvent = (sourceAudit.auditLog || []).some(e => e.action === 'BACKUP_CREATED_VERIFIED' && e.requestId === 'final-key-drill');
  const drEvent = (drAudit.auditLog || []).some(e => e.action === 'BACKUP_RESTORE_VERIFIED' && e.requestId === 'final-key-drill');
  if (!sourceEvent) fail('SOURCE_BACKUP_EVENT_MISSING');
  if (!drEvent) fail('DR_RESTORE_EVENT_MISSING');

  console.log(JSON.stringify({
    ok: true,
    gate: 'FINAL_KEY_BACKUP_RESTORE',
    backupEncrypted: true,
    backupVerified: true,
    manifestVersion: verified.manifest.version,
    backupKeyIdPresent: true,
    sourceBackupEvent: true,
    isolatedDrRestore: true,
    drRestoreEvent: true,
    sessionsRestored: false,
    stateIntegrity: true,
    documentIntegrity: true,
    auditIntegrity: true,
    restoredDocuments: restored.restoredDocuments,
    restoredVersion: restored.restoredVersion
  }));
} catch (error) {
  fail('UNEXPECTED', { name: error?.name || 'Error', message: String(error?.message || error).slice(0, 240) });
} finally {
  try { if (source?.pool) await source.pool.end(); } catch {}
  try { if (dr?.pool) await dr.pool.end(); } catch {}
  try { await fs.rm(backupRoot, { recursive: true, force: true }); } catch {}
}
