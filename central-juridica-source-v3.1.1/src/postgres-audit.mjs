import { appendAuditEntry, initializeAuditChain, verifyAuditChain } from './audit-integrity.mjs';

const MAX_RETAINED = 5000;

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

function clone(value) { return structuredClone(value); }

function normalizeAuditState(state = {}) {
  return {
    auditLog: Array.isArray(state.auditLog) ? clone(state.auditLog) : [],
    auditMeta: state.auditMeta && typeof state.auditMeta === 'object' ? clone(state.auditMeta) : {}
  };
}

export async function readAuditState(queryable, { forUpdate = false } = {}) {
  const metaSql = `SELECT payload FROM central_juridica_audit_meta WHERE singleton=TRUE${forUpdate ? ' FOR UPDATE' : ''}`;
  const metaResult = await queryable.query(metaSql);
  if (!metaResult.rows?.length) return { auditLog: [], auditMeta: {} };
  const auditMeta = clone(metaResult.rows[0].payload || {});
  const retained = Math.max(0, Math.min(MAX_RETAINED, Number(auditMeta.retainedCount || 0)));
  if (!retained) return { auditLog: [], auditMeta };
  const logResult = await queryable.query('SELECT payload FROM central_juridica_audit_log ORDER BY sequence_id DESC LIMIT $1', [retained]);
  return { auditLog: (logResult.rows || []).map(row => clone(row.payload)), auditMeta };
}

async function insertEntry(queryable, entry) {
  if (!entry?.id || !entry?.hash) throw new TypeError('Entrada de auditoria inválida.');
  await queryable.query('INSERT INTO central_juridica_audit_log(entry_id,payload) VALUES($1,$2::jsonb)', [entry.id, JSON.stringify(entry)]);
}

async function writeMeta(queryable, meta) {
  await queryable.query(`INSERT INTO central_juridica_audit_meta(singleton,payload,updated_at)
    VALUES(TRUE,$1::jsonb,now())
    ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload,updated_at=now()`, [JSON.stringify(meta || {})]);
}

function findAddedEntries(before, after) {
  const oldLog = before.auditLog || [];
  const newLog = after.auditLog || [];
  if (!oldLog.length) return newLog.slice();
  const oldHead = oldLog[0];
  const boundary = newLog.findIndex(entry => entry.id === oldHead.id && entry.hash === oldHead.hash);
  if (boundary < 0) throw new Error('AUDIT_APPEND_ONLY_VIOLATION: head histórico ausente após mutação.');
  const overlap = Math.min(oldLog.length, newLog.length - boundary);
  for (let i = 0; i < overlap; i += 1) {
    if (newLog[boundary + i]?.id !== oldLog[i]?.id || newLog[boundary + i]?.hash !== oldLog[i]?.hash) {
      throw new Error('AUDIT_APPEND_ONLY_VIOLATION: histórico existente foi alterado ou reordenado.');
    }
  }
  return newLog.slice(0, boundary);
}

export async function persistAuditDelta(queryable, beforeState, afterState, keyring) {
  const before = normalizeAuditState(beforeState);
  const after = normalizeAuditState(afterState);
  const verification = verifyAuditChain(after, keyring);
  if (!verification.ok) throw Object.assign(new Error('Trilha de auditoria inválida; persistência dedicada bloqueada.'), { verification });
  const added = findAddedEntries(before, after);
  for (const entry of added.slice().reverse()) await insertEntry(queryable, entry);
  await writeMeta(queryable, after.auditMeta);
  return { added: added.length, retained: after.auditLog.length };
}

export async function replaceAuditState(queryable, state, keyring) {
  const audit = normalizeAuditState(state);
  if (!audit.auditMeta?.initialized) initializeAuditChain(audit, keyring);
  const verification = verifyAuditChain(audit, keyring);
  if (!verification.ok) throw Object.assign(new Error('Snapshot de auditoria inválido; restore bloqueado.'), { verification });
  await queryable.query('DELETE FROM central_juridica_audit_log');
  await queryable.query('DELETE FROM central_juridica_audit_meta');
  for (const entry of audit.auditLog.slice().reverse()) await insertEntry(queryable, entry);
  await writeMeta(queryable, audit.auditMeta);
  return { restoredAuditEntries: audit.auditLog.length };
}

export async function migrateLegacyAudit(pool, normalizeState, keyring) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureAuditTables(client);
    const selected = await client.query('SELECT state FROM central_juridica_state WHERE singleton = TRUE FOR UPDATE');
    if (!selected.rows?.length) throw new Error('Estado PostgreSQL não inicializado.');
    const db = normalizeState(selected.rows[0].state);
    const existingMeta = await client.query('SELECT payload FROM central_juridica_audit_meta WHERE singleton=TRUE FOR UPDATE');
    if (!existingMeta.rows?.length) {
      initializeAuditChain(db, keyring);
      for (const entry of db.auditLog.slice().reverse()) await insertEntry(client, entry);
      await writeMeta(client, db.auditMeta);
    } else if (db.auditLog.length || Object.keys(db.auditMeta || {}).length) {
      const dedicated = await readAuditState(client);
      const dedicatedIds = new Set(dedicated.auditLog.map(entry => entry.id));
      const unknown = db.auditLog.filter(entry => !dedicatedIds.has(entry.id));
      if (unknown.length) throw new Error('AUDIT_MIGRATION_CONFLICT: JSONB contém entradas ausentes na auditoria dedicada.');
    }
    db.auditLog = [];
    db.auditMeta = {};
    await client.query('UPDATE central_juridica_state SET state=$1::jsonb,updated_at=now() WHERE singleton=TRUE', [JSON.stringify(db)]);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}

export async function appendDedicatedAudit(pool, fields, keyring) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await readAuditState(client, { forUpdate: true });
    if (!current.auditMeta?.initialized) initializeAuditChain(current, keyring);
    const before = normalizeAuditState(current);
    const entry = appendAuditEntry(current, fields, keyring);
    await persistAuditDelta(client, before, current, keyring);
    await client.query('COMMIT');
    return entry;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}
