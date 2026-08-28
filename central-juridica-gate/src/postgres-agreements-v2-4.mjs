const clone = value => structuredClone(value);

export async function ensureAgreementTable(queryable) {
  await queryable.query(`CREATE TABLE IF NOT EXISTS central_juridica_agreements (
    agreement_id text PRIMARY KEY,
    process_id text NOT NULL,
    status text NOT NULL,
    direction text NOT NULL,
    occurred_at date NULL,
    amount numeric(18,2) NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`);
  await queryable.query('CREATE INDEX IF NOT EXISTS central_juridica_agreements_process_idx ON central_juridica_agreements(process_id)');
  await queryable.query('CREATE INDEX IF NOT EXISTS central_juridica_agreements_status_date_idx ON central_juridica_agreements(status,occurred_at)');
}

export async function readAgreements(queryable) {
  const result = await queryable.query('SELECT payload FROM central_juridica_agreements ORDER BY created_at DESC, agreement_id DESC');
  return (result.rows || []).map(row => clone(row.payload));
}

export async function findAgreementById(queryable, id) {
  const result = await queryable.query('SELECT payload FROM central_juridica_agreements WHERE agreement_id=$1', [id]);
  return result.rows?.length ? clone(result.rows[0].payload) : null;
}

export async function insertAgreement(queryable, agreement) {
  await queryable.query(`INSERT INTO central_juridica_agreements(
    agreement_id,process_id,status,direction,occurred_at,amount,payload,created_at,updated_at
  ) VALUES($1,$2,$3,$4,$5::date,$6::numeric,$7::jsonb,$8::timestamptz,$9::timestamptz)`, [
    agreement.id, agreement.processId, String(agreement.status || 'Em negociação'), String(agreement.direction || 'Nossa proposta'),
    agreement.occurredAt || null, agreement.amount, JSON.stringify(agreement), agreement.createdAt, agreement.updatedAt
  ]);
  return clone(agreement);
}

export async function updateAgreement(queryable, agreement) {
  const result = await queryable.query(`UPDATE central_juridica_agreements SET
    process_id=$2,status=$3,direction=$4,occurred_at=$5::date,amount=$6::numeric,payload=$7::jsonb,updated_at=$8::timestamptz
    WHERE agreement_id=$1`, [
    agreement.id, agreement.processId, String(agreement.status || 'Em negociação'), String(agreement.direction || 'Nossa proposta'),
    agreement.occurredAt || null, agreement.amount, JSON.stringify(agreement), agreement.updatedAt
  ]);
  if (Number(result.rowCount || 0) !== 1) throw new Error('AGREEMENT_NOT_FOUND');
  return clone(agreement);
}

export async function migrateLegacyAgreements(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureAgreementTable(client);
    const selected = await client.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE FOR UPDATE');
    if (!selected.rows?.length) throw new Error('STATE_MISSING');
    const db = structuredClone(selected.rows[0].state || {});
    const legacy = Array.isArray(db.agreements) ? db.agreements : [];
    const existing = await readAgreements(client);
    if (!existing.length) {
      for (const agreement of legacy) await insertAgreement(client, agreement);
    } else if (legacy.length) {
      const ids = new Set(existing.map(item => item.id));
      if (legacy.some(item => !ids.has(item.id))) throw new Error('AGREEMENT_MIGRATION_CONFLICT');
    }
    db.agreements = [];
    await client.query('UPDATE central_juridica_state SET state=$1::jsonb,updated_at=now() WHERE singleton=TRUE', [JSON.stringify(db)]);
    await client.query('COMMIT');
    return { migrated: legacy.length };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}
