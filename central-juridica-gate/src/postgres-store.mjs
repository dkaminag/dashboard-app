import { emptyState, normalizeState } from './store.mjs';

export const POSTGRES_STATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS central_juridica_state (
  singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO central_juridica_state(singleton, state)
VALUES (TRUE, $1::jsonb)
ON CONFLICT (singleton) DO NOTHING;
`;

export class PostgresStateStore {
  constructor(pool) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('Pool PostgreSQL inválido.');
    this.pool = pool;
  }

  async ensure() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS central_juridica_state (
      singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
      state jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await this.pool.query(
      'INSERT INTO central_juridica_state(singleton, state) VALUES (TRUE, $1::jsonb) ON CONFLICT (singleton) DO NOTHING',
      [JSON.stringify(emptyState())]
    );
  }

  async read() {
    const result = await this.pool.query('SELECT state FROM central_juridica_state WHERE singleton = TRUE');
    if (!result.rows?.length) { await this.ensure(); return this.read(); }
    return normalizeState(result.rows[0].state);
  }

  async mutate(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query('SELECT state FROM central_juridica_state WHERE singleton = TRUE FOR UPDATE');
      if (!selected.rows?.length) throw new Error('Estado PostgreSQL não inicializado.');
      const db = normalizeState(selected.rows[0].state);
      const output = await fn(db);
      await client.query('UPDATE central_juridica_state SET state = $1::jsonb, updated_at = now() WHERE singleton = TRUE', [JSON.stringify(normalizeState(db))]);
      await client.query('COMMIT');
      return output;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async ping() {
    const result = await this.pool.query('SELECT 1 AS ok');
    if (result.rows?.[0]?.ok !== 1) throw new Error('PostgreSQL respondeu de forma inesperada ao ping.');
    return { ok: true, backend: 'postgres' };
  }

  async replaceState(nextState) {
    const normalized = normalizeState(nextState);
    return this.mutate(db => {
      for (const key of Object.keys(db)) delete db[key];
      Object.assign(db, structuredClone(normalized));
      return normalizeState(db);
    });
  }

  async appendAudit(action, entity, entityId, requestId, detail = {}, actor = null) {
    return this.mutate(db => {
      db.auditLog.unshift({ id: `audit_${cryptoRandom()}`, action, entity, entityId, requestId, actor, detail, at: new Date().toISOString() });
      db.auditLog = db.auditLog.slice(0, 5000);
    });
  }
}

function cryptoRandom() {
  return globalThis.crypto.randomUUID();
}
