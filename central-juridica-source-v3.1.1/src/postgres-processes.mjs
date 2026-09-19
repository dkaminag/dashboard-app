const clone = value => structuredClone(value);

export async function ensureProcessTable(queryable) {
  await queryable.query(`CREATE TABLE IF NOT EXISTS central_juridica_processes (
    process_id text PRIMARY KEY,
    client_id text NOT NULL,
    status text NOT NULL,
    area text NOT NULL,
    next_deadline date NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`);
  await queryable.query('CREATE INDEX IF NOT EXISTS central_juridica_processes_client_idx ON central_juridica_processes(client_id)');
  await queryable.query('CREATE INDEX IF NOT EXISTS central_juridica_processes_status_deadline_idx ON central_juridica_processes(status,next_deadline)');
}

export async function readProcesses(queryable) {
  const result = await queryable.query('SELECT payload FROM central_juridica_processes ORDER BY created_at DESC, process_id DESC');
  return (result.rows || []).map(row => clone(row.payload));
}

export async function findProcessById(queryable, id, { forUpdate = false } = {}) {
  const result = await queryable.query(`SELECT payload FROM central_juridica_processes WHERE process_id=$1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  return result.rows?.length ? clone(result.rows[0].payload) : null;
}

function values(processRecord) {
  return [processRecord.id, processRecord.clientId, String(processRecord.status || 'Ativo'), String(processRecord.area || 'Cível'), processRecord.nextDeadline || null, JSON.stringify(processRecord), processRecord.createdAt, processRecord.updatedAt];
}

export async function insertProcess(queryable, processRecord) {
  await queryable.query(`INSERT INTO central_juridica_processes(process_id,client_id,status,area,next_deadline,payload,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5::date,$6::jsonb,$7::timestamptz,$8::timestamptz)`, values(processRecord));
  return clone(processRecord);
}

export async function updateProcess(queryable, processRecord) {
  const params = [processRecord.id, processRecord.clientId, String(processRecord.status || 'Ativo'), String(processRecord.area || 'Cível'), processRecord.nextDeadline || null, JSON.stringify(processRecord), processRecord.updatedAt];
  const result = await queryable.query(`UPDATE central_juridica_processes SET client_id=$2,status=$3,area=$4,next_deadline=$5::date,payload=$6::jsonb,updated_at=$7::timestamptz WHERE process_id=$1`, params);
  if (Number(result.rowCount || 0) !== 1) throw new Error('PROCESS_NOT_FOUND');
  return clone(processRecord);
}

export async function migrateLegacyProcesses(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureProcessTable(client);
    const selected = await client.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE FOR UPDATE');
    if (!selected.rows?.length) throw new Error('STATE_MISSING');
    const db = structuredClone(selected.rows[0].state || {});
    const legacy = Array.isArray(db.processes) ? db.processes : [];
    const existing = await readProcesses(client);
    if (!existing.length) {
      for (const processRecord of legacy) await insertProcess(client, processRecord);
    } else if (legacy.length) {
      const ids = new Set(existing.map(item => item.id));
      if (legacy.some(item => !ids.has(item.id))) throw new Error('PROCESS_MIGRATION_CONFLICT');
    }
    db.processes = [];
    await client.query('UPDATE central_juridica_state SET state=$1::jsonb,updated_at=now() WHERE singleton=TRUE', [JSON.stringify(db)]);
    await client.query('COMMIT');
    return { migrated: legacy.length };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}
