import crypto from 'node:crypto';

export const LOGIN_RATE_LIMIT = Object.freeze({ limit: 10, windowMs: 15 * 60_000 });

export function hashRateLimitKey(scope, identifier) {
  const safeScope = String(scope || '').trim().toLowerCase();
  if (!safeScope || !identifier) throw new TypeError('Escopo e identificador do rate limit são obrigatórios.');
  return `${safeScope}:${crypto.createHash('sha256').update(String(identifier), 'utf8').digest('hex')}`;
}

export class MemoryRateLimiter {
  constructor() { this.slots = new Map(); this.backend = 'memory'; }
  async ensure() {}
  cleanup(now = Date.now()) { for (const [key, value] of this.slots) if (value.resetAt <= now) this.slots.delete(key); }
  async consume(key, { limit = 10, windowMs = 15 * 60_000, now = Date.now() } = {}) {
    if (this.slots.size > 5000) this.cleanup(now);
    let slot = this.slots.get(key);
    if (!slot || slot.resetAt <= now) slot = { count: 0, resetAt: now + windowMs };
    slot.count += 1; this.slots.set(key, slot);
    return { allowed: slot.count <= limit, count: slot.count, remaining: Math.max(0, limit - slot.count), resetAt: new Date(slot.resetAt).toISOString(), backend: this.backend };
  }
  async reset(key) { this.slots.delete(key); }
}

export class PostgresRateLimiter {
  constructor(pool) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('Pool PostgreSQL inválido para rate limiter.');
    this.pool = pool; this.backend = 'postgres'; this.operations = 0;
  }
  async ensure() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS central_juridica_rate_limits (
      rate_key text PRIMARY KEY,
      count integer NOT NULL CHECK (count >= 0),
      reset_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS central_juridica_rate_limits_reset_at_idx ON central_juridica_rate_limits(reset_at)');
  }
  async consume(key, { limit = 10, windowMs = 15 * 60_000, now = Date.now() } = {}) {
    const resetAt = new Date(now + windowMs).toISOString();
    const current = new Date(now).toISOString();
    const result = await this.pool.query(`
      INSERT INTO central_juridica_rate_limits(rate_key, count, reset_at, updated_at)
      VALUES($1, 1, $2::timestamptz, now())
      ON CONFLICT(rate_key) DO UPDATE SET
        count = CASE WHEN central_juridica_rate_limits.reset_at <= $3::timestamptz THEN 1 ELSE central_juridica_rate_limits.count + 1 END,
        reset_at = CASE WHEN central_juridica_rate_limits.reset_at <= $3::timestamptz THEN EXCLUDED.reset_at ELSE central_juridica_rate_limits.reset_at END,
        updated_at = now()
      RETURNING count, reset_at`, [key, resetAt, current]);
    const row = result.rows?.[0];
    if (!row) throw new Error('Rate limiter PostgreSQL não retornou estado.');
    const count = Number(row.count);
    this.operations += 1;
    if (this.operations % 256 === 0) await this.cleanupExpired(now);
    return { allowed: count <= limit, count, remaining: Math.max(0, limit - count), resetAt: new Date(row.reset_at).toISOString(), backend: this.backend };
  }
  async reset(key) { await this.pool.query('DELETE FROM central_juridica_rate_limits WHERE rate_key=$1', [key]); }
  async cleanupExpired(now = Date.now()) { return this.pool.query('DELETE FROM central_juridica_rate_limits WHERE reset_at <= $1::timestamptz', [new Date(now).toISOString()]); }
}

export function createRateLimiter({ pool } = {}) { return pool ? new PostgresRateLimiter(pool) : new MemoryRateLimiter(); }
