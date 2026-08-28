const clone = value => structuredClone(value);

export async function ensureExecutionTable(queryable) {
  await queryable.query(`CREATE TABLE IF NOT EXISTS central_juridica_execution_actions (
    execution_id text PRIMARY KEY,
    process_id text NOT NULL,
    measure text NOT NULL,
    status text NOT NULL,
    requested_at date NULL,
    review_date date NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`);
  await queryable.query('CREATE INDEX IF NOT EXISTS central_juridica_execution_actions_process_idx ON central_juridica_execution_actions(process_id)');
  await queryable.query('CREATE INDEX IF NOT EXISTS central_juridica_execution_actions_status_review_idx ON central_juridica_execution_actions(status,review_date)');
}

export async function readExecutionActions(queryable) {
  const result = await queryable.query('SELECT payload FROM central_juridica_execution_actions ORDER BY created_at DESC, execution_id DESC');
  return (result.rows || []).map(row => clone(row.payload));
}

export async function findExecutionActionById(queryable, id) {
  const result = await queryable.query('SELECT payload FROM central_juridica_execution_actions WHERE execution_id=$1', [id]);
  return result.rows?.length ? clone(result.rows[0].payload) : null;
}

const params = action => [action.id,action.processId,String(action.measure),String(action.status||'Planejada'),action.requestedAt||null,action.reviewDate||null,JSON.stringify(action),action.createdAt,action.updatedAt];
export async function insertExecutionAction(queryable, action) { await queryable.query(`INSERT INTO central_juridica_execution_actions(execution_id,process_id,measure,status,requested_at,review_date,payload,created_at,updated_at) VALUES($1,$2,$3,$4,$5::date,$6::date,$7::jsonb,$8::timestamptz,$9::timestamptz)`, params(action)); return clone(action); }
export async function updateExecutionAction(queryable, action) { const result=await queryable.query(`UPDATE central_juridica_execution_actions SET process_id=$2,measure=$3,status=$4,requested_at=$5::date,review_date=$6::date,payload=$7::jsonb,updated_at=$8::timestamptz WHERE execution_id=$1`,[action.id,action.processId,String(action.measure),String(action.status||'Planejada'),action.requestedAt||null,action.reviewDate||null,JSON.stringify(action),action.updatedAt]);if(Number(result.rowCount||0)!==1)throw new Error('EXECUTION_ACTION_NOT_FOUND');return clone(action); }

export async function migrateLegacyExecutionActions(pool) {
  const client=await pool.connect();try{await client.query('BEGIN');await ensureExecutionTable(client);const selected=await client.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE FOR UPDATE');if(!selected.rows?.length)throw new Error('STATE_MISSING');const db=structuredClone(selected.rows[0].state||{}),legacy=Array.isArray(db.executionActions)?db.executionActions:[],existing=await readExecutionActions(client);if(!existing.length){for(const action of legacy)await insertExecutionAction(client,action);}else if(legacy.length){const ids=new Set(existing.map(x=>x.id));if(legacy.some(x=>!ids.has(x.id)))throw new Error('EXECUTION_ACTION_MIGRATION_CONFLICT');}db.executionActions=[];await client.query('UPDATE central_juridica_state SET state=$1::jsonb,updated_at=now() WHERE singleton=TRUE',[JSON.stringify(db)]);await client.query('COMMIT');return{migrated:legacy.length};}catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}finally{client.release();}
}
