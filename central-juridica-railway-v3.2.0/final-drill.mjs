import crypto from 'node:crypto';
import { createStore } from './runtime/src/store-factory.mjs';
import { createBackup, verifyBackup, restoreBackup } from './runtime/src/backup.mjs';

const runtimeEnv = String(process.env.CJ_ENV || '').trim();
if (runtimeEnv !== 'production') throw new Error('FINAL_DR_REQUIRES_PRODUCTION_ENV');

const src = String(process.env.CJ_DATABASE_URL || '').trim();
const dst = String(process.env.CJ_DR_DATABASE_URL || '').trim();
if (!src || !dst) throw new Error('FINAL_DR_DATABASE_URL_MISSING');

const signature = value => {
  const u = new URL(value);
  return [u.protocol, u.hostname, u.port || '5432', u.pathname, u.username].join('|');
};
if (signature(src) === signature(dst)) throw new Error('FINAL_DR_SOURCE_TARGET_NOT_ISOLATED');

const source = await createStore({ databaseUrl: src });
const target = await createStore({ databaseUrl: dst });

const stable = snapshot => {
  const state = structuredClone(snapshot.state);
  state.sessions = [];
  state.idempotency = {};
  state.auditLog = [];
  state.auditMeta = {};
  const documents = (snapshot.documents || [])
    .map(d => ({ documentId: d.documentId, storedSha256: d.storedSha256, size: d.payload?.length || 0 }))
    .sort((a, b) => String(a.documentId).localeCompare(String(b.documentId)));
  return { state, documents };
};
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

try {
  await source.store.ensure();
  await target.store.ensure();

  const before = await source.store.exportSnapshot();
  const backup = await createBackup({
    store: source.store,
    documentDir: '/tmp/cj-source-documents',
    backupRoot: '/tmp/cj-final-key-dr',
    backend: 'postgres'
  });

  const verified = await verifyBackup(backup.target);
  if (!verified.ok) throw new Error('FINAL_DR_BACKUP_VERIFY_FAILED:' + verified.errors.join(','));

  const restored = await restoreBackup({
    store: target.store,
    documentDir: '/tmp/cj-target-documents',
    target: backup.target,
    backend: 'postgres'
  });

  const after = await target.store.exportSnapshot();
  const sourceFingerprint = digest(stable(before));
  const targetFingerprint = digest(stable(after));
  if (sourceFingerprint !== targetFingerprint) throw new Error('FINAL_DR_SEMANTIC_FINGERPRINT_MISMATCH');

  const sessions = await target.pool.query('SELECT count(*)::int AS n FROM central_juridica_sessions');
  const sessionCount = Number(sessions.rows?.[0]?.n || 0);
  if (sessionCount !== 0) throw new Error('FINAL_DR_SESSIONS_RESTORED');

  console.log(JSON.stringify({
    event: 'FINAL_KEY_BACKUP_RESTORE_VERIFIED',
    version: '3.2.0-preview',
    passed: true,
    sourceTargetSeparated: true,
    manifestVersion: verified.manifest?.version || null,
    backupKeyIdPresent: Boolean(verified.manifest?.crypto?.keyId),
    documents: verified.manifest?.documents?.length || 0,
    restoredDocuments: restored.restoredDocuments || 0,
    restoredUsers: restored.restoredUsers || 0,
    restoredAuditEntries: restored.restoredAuditEntries || 0,
    sessionsRestored: sessionCount,
    semanticFingerprint: sourceFingerprint
  }));
} finally {
  if (source.pool) await source.pool.end();
  if (target.pool) await target.pool.end();
}
