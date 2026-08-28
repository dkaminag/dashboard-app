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

export async function readFinancialEntries(queryable) { const result=await queryable.query('SELECT payload FROM central_juridica_financial_entries ORDER BY created_at DESC, financial_entry_id DESC'); return (result.rows||[]).map(row=>clone(row.payload)); }
export async function findFinancialEntryById(queryable,id) { const result=await queryable.query('SELECT payload FROM central_juridica_financial_entries WHERE financial_entry_id=$1',[id]); return result.rows?.length?clone(result.rows[0].payload):null; }
const params=e=>[e.id,e.clientId,e.processId||null,String(e.direction),String(e.category),String(e.status||'Previsto'),e.dueDate||null,e.settledAt||null,e.amount,JSON.stringify(e),e.createdAt,e.updatedAt];
export async function insertFinancialEntry(queryable,e) { await queryable.query(`INSERT INTO central_juridica_financial_entries(financial_entry_id,client_id,process_id,direction,category,status,due_date,settled_at,amount,payload,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9::numeric,$10::jsonb,$11::timestamptz,$12::timestamptz)`,params(e)); return clone(e); }
export async function updateFinancialEntry(queryable,e) { const r=await queryable.query(`UPDATE central_juridica_financial_entries SET client_id=$2,process_id=$3,direction=$4,category=$5,status=$6,due_date=$7::date,settled_at=$8::date,amount=$9::numeric,payload=$10::jsonb,updated_at=$11::timestamptz WHERE financial_entry_id=$1`,[e.id,e.clientId,e.processId||null,String(e.direction),String(e.category),String(e.status||'Previsto'),e.dueDate||null,e.settledAt||null,e.amount,JSON.stringify(e),e.updatedAt]); if(Number(r.rowCount||0)!==1)throw new Error('FINANCIAL_ENTRY_NOT_FOUND'); return clone(e); }
export async function migrateLegacyFinancialEntries(pool) { const c=await pool.connect(); try{await c.query('BEGIN');await ensureFinancialEntryTable(c);const selected=await c.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE FOR UPDATE');if(!selected.rows?.length)throw new Error('STATE_MISSING');const db=structuredClone(selected.rows[0].state||{}),legacy=Array.isArray(db.financialEntries)?db.financialEntries:[],existing=await readFinancialEntries(c);if(!existing.length){for(const e of legacy)await insertFinancialEntry(c,e);}else if(legacy.length){const ids=new Set(existing.map(x=>x.id));if(legacy.some(x=>!ids.has(x.id)))throw new Error('FINANCIAL_ENTRY_MIGRATION_CONFLICT');}db.financialEntries=[];await c.query('UPDATE central_juridica_state SET state=$1::jsonb,updated_at=now() WHERE singleton=TRUE',[JSON.stringify(db)]);await c.query('COMMIT');return{migrated:legacy.length};}catch(e){try{await c.query('ROLLBACK');}catch{}throw e;}finally{c.release();} }
