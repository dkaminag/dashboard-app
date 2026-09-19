const clone = value => structuredClone(value);

export async function ensureFinancialEntryTable(queryable) {
  await queryable.query(`CREATE TABLE IF NOT EXISTS central_juridica_financial_entries (
    financial_entry_id text PRIMARY KEY,
    client_id text NOT NULL,
    process_id text NULL,
    direction text NOT NULL,
    category text NOT NULL,
    status text NOT NULL,
    due_date date NULL,
    settled_at date NULL,
    amount numeric(18,2) NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`);
  await queryable.query('CREATE INDEX IF NOT EXISTS central_juridica_financial_entries_client_idx ON central_juridica_financial_entries(client_id)');
  await queryable.query('CREATE INDEX IF NOT EXISTS central_juridica_financial_entries_process_idx ON central_juridica_financial_entries(process_id)');
  await queryable.query('CREATE INDEX IF NOT EXISTS central_juridica_financial_entries_status_due_idx ON central_juridica_financial_entries(status,due_date)');
}

export async function readFinancialEntries(queryable) {
  const result = await queryable.query('SELECT payload FROM central_juridica_financial_entries ORDER BY created_at DESC, financial_entry_id DESC');
  return (result.rows || []).map(row => clone(row.payload));
}

export async function findFinancialEntryById(queryable, id) {
  const result = await queryable.query('SELECT payload FROM central_juridica_financial_entries WHERE financial_entry_id=$1', [id]);
  return result.rows?.length ? clone(result.rows[0].payload) : null;
}

function params(entry) {
  return [entry.id, entry.clientId, entry.processId || null, String(entry.direction), String(entry.category), String(entry.status || 'Previsto'), entry.dueDate || null, entry.settledAt || null, entry.amount, JSON.stringify(entry), entry.createdAt, entry.updatedAt];
}

export async function insertFinancialEntry(queryable, entry) {
  await queryable.query(`INSERT INTO central_juridica_financial_entries(
    financial_entry_id,client_id,process_id,direction,category,status,due_date,settled_at,amount,payload,created_at,updated_at
  ) VALUES($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9::numeric,$10::jsonb,$11::timestamptz,$12::timestamptz)`, params(entry));
  return clone(entry);
}

export async function updateFinancialEntry(queryable, entry) {
  const result = await queryable.query(`UPDATE central_juridica_financial_entries SET
    client_id=$2,process_id=$3,direction=$4,category=$5,status=$6,due_date=$7::date,settled_at=$8::date,amount=$9::numeric,payload=$10::jsonb,updated_at=$11::timestamptz
    WHERE financial_entry_id=$1`, [entry.id, entry.clientId, entry.processId || null, String(entry.direction), String(entry.category), String(entry.status || 'Previsto'), entry.dueDate || null, entry.settledAt || null, entry.amount, JSON.stringify(entry), entry.updatedAt]);
  if (Number(result.rowCount || 0) !== 1) throw new Error('FINANCIAL_ENTRY_NOT_FOUND');
  return clone(entry);
}

export async function migrateLegacyFinancialEntries(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureFinancialEntryTable(client);
    const selected = await client.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE FOR UPDATE');
    if (!selected.rows?.length) throw new Error('STATE_MISSING');
    const db = structuredClone(selected.rows[0].state || {});
    const legacy = Array.isArray(db.financialEntries) ? db.financialEntries : [];
    const existing = await readFinancialEntries(client);
    if (!existing.length) {
      for (const entry of legacy) await insertFinancialEntry(client, entry);
    } else if (legacy.length) {
      const ids = new Set(existing.map(item => item.id));
      if (legacy.some(item => !ids.has(item.id))) throw new Error('FINANCIAL_ENTRY_MIGRATION_CONFLICT');
    }
    db.financialEntries = [];
    await client.query('UPDATE central_juridica_state SET state=$1::jsonb,updated_at=now() WHERE singleton=TRUE', [JSON.stringify(db)]);
    await client.query('COMMIT');
    return { migrated: legacy.length };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}
