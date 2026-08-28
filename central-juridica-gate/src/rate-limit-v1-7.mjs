import crypto from 'node:crypto';

export function hashRateLimitKey(scope, identifier) {
  const safeScope = String(scope || '').trim().toLowerCase();
  if (!safeScope || !identifier) throw new TypeError('Escopo e identificador obrigatórios.');
  return `${safeScope}:${crypto.createHash('sha256').update(String(identifier), 'utf8').digest('hex')}`;
}

export class PostgresRateLimiter {
  constructor(pool) { if (!pool?.query) throw new TypeError('Pool PostgreSQL inválido.'); this.pool = pool; }
  async ensure() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS central_juridica_rate_limits (
      rate_key text PRIMARY KEY,
      count integer NOT NULL CHECK (count >= 0),
      reset_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS central_juridica_rate_limits_reset_at_idx ON central_juridica_rate_limits(reset_at)');
  }
  async consume(key, { limit = 10, windowMs = 900000, now = Date.now() } = {}) {
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
    if (!row) throw new Error('Rate limiter sem retorno.');
    const count = Number(row.count);
    return { allowed: count <= limit, count, remaining: Math.max(0, limit - count), resetAt: new Date(row.reset_at).toISOString() };
  }
  async reset(key) { await this.pool.query('DELETE FROM central_juridica_rate_limits WHERE rate_key=$1', [key]); }
}
