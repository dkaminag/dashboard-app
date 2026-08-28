import { appendAudit, currentMetaMac, migrateAudit, verifyAudit } from './audit-integrity-v1-6.mjs';

const MAX_RETAINED = 5000;
const clone = value => structuredClone(value);

export async function ensureAuditTables(queryable) {
  await queryable.query(`CREATE TABLE IF NOT EXISTS central_juridica_audit_log (
    sequence_id bigserial PRIMARY KEY,
    entry_id text NOT NULL UNIQUE,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await queryable.query('CREATE INDEX IF NOT EXISTS central_juridica_audit_log_sequence_idx ON central_juridica_audit_log(sequence_id DESC)');
  await queryable.query(`CREATE TABLE IF NOT EXISTS central_juridica_audit_meta (
    singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
    payload jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
}

export function emptyAuditState(ring, now = new Date().toISOString()) {
  const auditMeta = {
    initialized: true, metaVersion: 3, latestEntryVersion: 2, initializedAt: now,
    baselineCount: 0, headHash: null, tailHash: null, retainedCount: 0,
    droppedCount: 0, lastAppendedAt: null, legacyKeyId: ring.legacyKeyId,
    metaKeyId: ring.activeKeyId
  };
  auditMeta.metaMac = currentMetaMac(auditMeta, ring);
  return { auditLog: [], auditMeta };
}

export async function readAuditState(queryable, { forUpdate = false } = {}) {
  const meta = await queryable.query(`SELECT payload FROM central_juridica_audit_meta WHERE singleton=TRUE${forUpdate ? ' FOR UPDATE' : ''}`);
  if (!meta.rows?.length) return { auditLog: [], auditMeta: {} };
  const auditMeta = clone(meta.rows[0].payload || {});
  const retained = Math.max(0, Math.min(MAX_RETAINED, Number(auditMeta.retainedCount || 0)));
  const log = retained ? await queryable.query('SELECT payload FROM central_juridica_audit_log ORDER BY sequence_id DESC LIMIT $1', [retained]) : { rows: [] };
  return { auditLog: (log.rows || []).map(row => clone(row.payload)), auditMeta };
}

async function insertEntry(queryable, entry) {
  await queryable.query('INSERT INTO central_juridica_audit_log(entry_id,payload) VALUES($1,$2::jsonb)', [entry.id, JSON.stringify(entry)]);
}
async function writeMeta(queryable, meta) {
  await queryable.query(`INSERT INTO central_juridica_audit_meta(singleton,payload,updated_at) VALUES(TRUE,$1::jsonb,now())
    ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload,updated_at=now()`, [JSON.stringify(meta)]);
}

export async function seedAuditState(queryable, state, ring) {
  const verification = verifyAudit(state, ring);
  if (!verification.ok) throw Object.assign(new Error('AUDIT_SEED_INVALID'), { verification });
  await queryable.query('DELETE FROM central_juridica_audit_log');
  await queryable.query('DELETE FROM central_juridica_audit_meta');
  for (const entry of state.auditLog.slice().reverse()) await insertEntry(queryable, entry);
  await writeMeta(queryable, state.auditMeta);
}

export async function migrateLegacyJsonbAudit(client, state, ring) {
  await ensureAuditTables(client);
  const current = await client.query('SELECT payload FROM central_juridica_audit_meta WHERE singleton=TRUE FOR UPDATE');
  if (current.rows?.length) return { migrated: false, reason: 'already-dedicated' };
  if (!state.auditMeta?.initialized) Object.assign(state, emptyAuditState(ring));
  else migrateAudit(state, ring);
  const verification = verifyAudit(state, ring);
  if (!verification.ok) throw Object.assign(new Error('AUDIT_MIGRATION_INVALID'), { verification });
  for (const entry of state.auditLog.slice().reverse()) await insertEntry(client, entry);
  await writeMeta(client, state.auditMeta);
  state.auditLog = []; state.auditMeta = {};
  return { migrated: true };
}

export async function appendDedicatedAudit(pool, fields, ring) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let state = await readAuditState(client, { forUpdate: true });
    if (!state.auditMeta?.initialized) { state = emptyAuditState(ring); await writeMeta(client, state.auditMeta); }
    const entry = appendAudit(state, fields, ring);
    await insertEntry(client, entry);
    await writeMeta(client, state.auditMeta);
    await client.query('COMMIT');
    return entry;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}

export async function replaceAuditState(client, state, ring) {
  const verification = verifyAudit(state, ring);
  if (!verification.ok) throw Object.assign(new Error('AUDIT_RESTORE_INVALID'), { verification });
  await client.query('DELETE FROM central_juridica_audit_log');
  await client.query('DELETE FROM central_juridica_audit_meta');
  for (const entry of state.auditLog.slice().reverse()) await insertEntry(client, entry);
  await writeMeta(client, state.auditMeta);
  return { restoredAuditEntries: state.auditLog.length };
}
