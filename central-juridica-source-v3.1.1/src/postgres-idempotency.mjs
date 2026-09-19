import crypto from 'node:crypto';

const DEV_SEED = 'central-juridica-development-idempotency-key-v2-1';
export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_IDEMPOTENCY_RESPONSE_BYTES = 64 * 1024;

function decodeKey(value) {
  if (!value) return null;
  try {
    const b = Buffer.from(String(value), 'base64url');
    if (b.length === 32) return b;
  } catch {}
  const raw = Buffer.from(String(value), 'utf8');
  return raw.length >= 32 ? crypto.createHash('sha256').update(raw).digest() : null;
}

export function loadIdempotencyKey(value = process.env.CJ_IDEMPOTENCY_KEY, { production = process.env.CJ_ENV === 'production' } = {}) {
  if (!value) {
    if (production) throw new Error('Modo production exige CJ_IDEMPOTENCY_KEY para proteger Idempotency-Key persistidas.');
    return crypto.createHash('sha256').update(DEV_SEED).digest();
  }
  const key = decodeKey(value);
  if (!key) throw new Error('CJ_IDEMPOTENCY_KEY deve ter ao menos 32 bytes ou ser base64url de 32 bytes.');
  return key;
}

export function idempotencyDigest(scope, rawKey, secret) {
  const normalizedScope = String(scope || '').trim().toLowerCase();
  const key = String(rawKey || '');
  if (!normalizedScope || !key) throw new TypeError('Escopo e Idempotency-Key são obrigatórios.');
  return crypto.createHmac('sha256', secret).update(normalizedScope).update('\0').update(key).digest('hex');
}

export function advisoryLockIdFromDigest(digest) {
  if (!/^[a-f0-9]{64}$/.test(String(digest || ''))) throw new TypeError('Digest de idempotência inválido.');
  const unsigned = BigInt(`0x${digest.slice(0, 16)}`);
  return (unsigned & ((1n << 63n) - 1n)).toString();
}

export async function ensureIdempotencyTable(queryable) {
  await queryable.query(`CREATE TABLE IF NOT EXISTS central_juridica_idempotency (
    scope text NOT NULL,
    key_hash char(64) NOT NULL,
    response jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    PRIMARY KEY(scope, key_hash)
  )`);
  await queryable.query('CREATE INDEX IF NOT EXISTS central_juridica_idempotency_expires_idx ON central_juridica_idempotency(expires_at)');
}

export async function migrateLegacyIdempotency(pool, normalizeState, secret, { ttlMs = DEFAULT_IDEMPOTENCY_TTL_MS } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureIdempotencyTable(client);
    const selected = await client.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE FOR UPDATE');
    if (!selected.rows?.length) throw new Error('Estado PostgreSQL não inicializado para migração de idempotência.');
    const db = normalizeState(selected.rows[0].state);
    const entries = Object.entries(db.idempotency || {});
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    let migrated = 0;
    for (const [fullKey, response] of entries) {
      const separator = fullKey.indexOf(':');
      if (separator <= 0 || separator === fullKey.length - 1) continue;
      const scope = fullKey.slice(0, separator).trim().toLowerCase();
      const rawKey = fullKey.slice(separator + 1);
      const digest = idempotencyDigest(scope, rawKey, secret);
      const serialized = JSON.stringify(response);
      if (Buffer.byteLength(serialized) > MAX_IDEMPOTENCY_RESPONSE_BYTES) continue;
      await client.query(`INSERT INTO central_juridica_idempotency(scope,key_hash,response,expires_at)
        VALUES($1,$2,$3::jsonb,$4::timestamptz)
        ON CONFLICT(scope,key_hash) DO NOTHING`, [scope, digest, serialized, expiresAt]);
      migrated++;
    }
    db.idempotency = {};
    await client.query('UPDATE central_juridica_state SET state=$1::jsonb,updated_at=now() WHERE singleton=TRUE', [JSON.stringify(db)]);
    await client.query('COMMIT');
    return { migrated, clearedLegacy: entries.length };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}

export async function acquireIdempotencyLock(client, scope, rawKey, secret) {
  const keyHash = idempotencyDigest(scope, rawKey, secret);
  const lockId = advisoryLockIdFromDigest(keyHash);
  await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockId]);
  return { scope: String(scope).trim().toLowerCase(), keyHash, lockId };
}

export async function readIdempotencyResult(queryable, scope, keyHash) {
  const result = await queryable.query(`SELECT response,expires_at FROM central_juridica_idempotency
    WHERE scope=$1 AND key_hash=$2 AND expires_at>now()`, [scope, keyHash]);
  if (!result.rows?.length) return null;
  return structuredClone(result.rows[0].response);
}

export async function storeIdempotencyResult(queryable, scope, keyHash, response, { ttlMs = DEFAULT_IDEMPOTENCY_TTL_MS } = {}) {
  const serialized = JSON.stringify(response);
  if (Buffer.byteLength(serialized) > MAX_IDEMPOTENCY_RESPONSE_BYTES) throw new Error('Resposta idempotente excede limite de persistência.');
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await queryable.query(`INSERT INTO central_juridica_idempotency(scope,key_hash,response,created_at,expires_at)
    VALUES($1,$2,$3::jsonb,now(),$4::timestamptz)
    ON CONFLICT(scope,key_hash) DO UPDATE SET response=excluded.response,created_at=now(),expires_at=excluded.expires_at`,
    [scope, keyHash, serialized, expiresAt]);
  return { expiresAt };
}

export async function clearExpiredIdempotency(queryable) {
  const result = await queryable.query('DELETE FROM central_juridica_idempotency WHERE expires_at<=now()');
  return Number(result.rowCount || 0);
}
