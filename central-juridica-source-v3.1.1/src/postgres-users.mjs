export async function ensureUserTable(queryable) {
  await queryable.query(`CREATE TABLE IF NOT EXISTS central_juridica_users (
    user_id text PRIMARY KEY,
    username_normalized text NOT NULL UNIQUE,
    payload jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
}

export async function readUsers(queryable) {
  const result = await queryable.query('SELECT payload FROM central_juridica_users ORDER BY username_normalized');
  return (result.rows || []).map(row => structuredClone(row.payload));
}

export async function findUserById(queryable, userId) {
  const result = await queryable.query('SELECT payload FROM central_juridica_users WHERE user_id=$1', [userId]);
  return result.rows?.length ? structuredClone(result.rows[0].payload) : null;
}

export async function findUserByUsername(queryable, username) {
  const normalized = String(username || '').toLowerCase();
  const result = await queryable.query('SELECT payload FROM central_juridica_users WHERE username_normalized=$1', [normalized]);
  return result.rows?.length ? structuredClone(result.rows[0].payload) : null;
}

export async function syncUsers(queryable, users) {
  await queryable.query('DELETE FROM central_juridica_users');
  for (const user of users || []) {
    if (!user?.id || !user?.username) throw new TypeError('Usuário PostgreSQL inválido.');
    await queryable.query('INSERT INTO central_juridica_users(user_id,username_normalized,payload,updated_at) VALUES($1,$2,$3::jsonb,now())',
      [user.id, String(user.username).toLowerCase(), JSON.stringify(user)]);
  }
}

export async function migrateLegacyUsers(pool, normalizeState) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query('SELECT state FROM central_juridica_state WHERE singleton = TRUE FOR UPDATE');
    if (!selected.rows?.length) throw new Error('Estado PostgreSQL não inicializado.');
    const db = normalizeState(selected.rows[0].state);
    if (db.users.length) {
      const existing = await readUsers(client);
      const byId = new Map(existing.map(user => [user.id, user]));
      for (const user of db.users) if (!byId.has(user.id)) byId.set(user.id, user);
      await syncUsers(client, [...byId.values()]);
      db.users = [];
      await client.query('UPDATE central_juridica_state SET state=$1::jsonb,updated_at=now() WHERE singleton=TRUE', [JSON.stringify(db)]);
    }
    await client.query('COMMIT');
  } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
  finally { client.release(); }
}
