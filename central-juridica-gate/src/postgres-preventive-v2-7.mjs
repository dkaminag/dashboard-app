const clone = value => structuredClone(value);

export async function ensurePreventiveAssessmentTable(queryable) {
  await queryable.query(`CREATE TABLE IF NOT EXISTS central_juridica_preventive_assessments (
    assessment_id text PRIMARY KEY,
    client_id text NOT NULL,
    status text NOT NULL,
    reference_date date NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`);
  await queryable.query('CREATE INDEX IF NOT EXISTS central_juridica_preventive_assessments_client_idx ON central_juridica_preventive_assessments(client_id)');
  await queryable.query('CREATE INDEX IF NOT EXISTS central_juridica_preventive_assessments_status_reference_idx ON central_juridica_preventive_assessments(status,reference_date)');
}

export async function readPreventiveAssessments(queryable) {
  const result = await queryable.query('SELECT payload FROM central_juridica_preventive_assessments ORDER BY created_at DESC, assessment_id DESC');
  return (result.rows || []).map(row => clone(row.payload));
}

export async function findPreventiveAssessmentById(queryable, id) {
  const result = await queryable.query('SELECT payload FROM central_juridica_preventive_assessments WHERE assessment_id=$1', [id]);
  return result.rows?.length ? clone(result.rows[0].payload) : null;
}

function params(assessment) {
  return [assessment.id, assessment.clientId, String(assessment.status || 'Em andamento'), assessment.referenceDate || null, JSON.stringify(assessment), assessment.createdAt, assessment.updatedAt];
}

export async function insertPreventiveAssessment(queryable, assessment) {
  await queryable.query(`INSERT INTO central_juridica_preventive_assessments(
    assessment_id,client_id,status,reference_date,payload,created_at,updated_at
  ) VALUES($1,$2,$3,$4::date,$5::jsonb,$6::timestamptz,$7::timestamptz)`, params(assessment));
  return clone(assessment);
}

export async function updatePreventiveAssessment(queryable, assessment) {
  const result = await queryable.query(`UPDATE central_juridica_preventive_assessments SET
    client_id=$2,status=$3,reference_date=$4::date,payload=$5::jsonb,updated_at=$6::timestamptz
    WHERE assessment_id=$1`, [assessment.id, assessment.clientId, String(assessment.status || 'Em andamento'), assessment.referenceDate || null, JSON.stringify(assessment), assessment.updatedAt]);
  if (Number(result.rowCount || 0) !== 1) throw new Error('PREVENTIVE_ASSESSMENT_NOT_FOUND');
  return clone(assessment);
}

export async function migrateLegacyPreventiveAssessments(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensurePreventiveAssessmentTable(client);
    const selected = await client.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE FOR UPDATE');
    if (!selected.rows?.length) throw new Error('STATE_MISSING');
    const db = structuredClone(selected.rows[0].state || {});
    const legacy = Array.isArray(db.preventiveAssessments) ? db.preventiveAssessments : [];
    const existing = await readPreventiveAssessments(client);
    if (!existing.length) {
      for (const assessment of legacy) await insertPreventiveAssessment(client, assessment);
    } else if (legacy.length) {
      const ids = new Set(existing.map(item => item.id));
      if (legacy.some(item => !ids.has(item.id))) throw new Error('PREVENTIVE_ASSESSMENT_MIGRATION_CONFLICT');
    }
    db.preventiveAssessments = [];
    await client.query('UPDATE central_juridica_state SET state=$1::jsonb,updated_at=now() WHERE singleton=TRUE', [JSON.stringify(db)]);
    await client.query('COMMIT');
    return { migrated: legacy.length };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally { client.release(); }
}
