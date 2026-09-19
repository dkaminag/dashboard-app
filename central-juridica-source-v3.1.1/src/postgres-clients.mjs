const clone = value => structuredClone(value);
export async function ensureClientTable(q){
  await q.query(`CREATE TABLE IF NOT EXISTS central_juridica_clients(
    client_id text PRIMARY KEY,
    name text NOT NULL,
    status text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL
  )`);
  await q.query('CREATE INDEX IF NOT EXISTS central_juridica_clients_name_idx ON central_juridica_clients(lower(name))');
  await q.query('CREATE INDEX IF NOT EXISTS central_juridica_clients_status_idx ON central_juridica_clients(status)');
}
export async function readClients(q){const r=await q.query('SELECT payload FROM central_juridica_clients ORDER BY created_at DESC, client_id DESC');return(r.rows||[]).map(x=>clone(x.payload));}
export async function findClientById(q,id){const r=await q.query('SELECT payload FROM central_juridica_clients WHERE client_id=$1',[id]);return r.rows?.length?clone(r.rows[0].payload):null;}
export async function insertClient(q,x){await q.query('INSERT INTO central_juridica_clients(client_id,name,status,payload,created_at,updated_at) VALUES($1,$2,$3,$4::jsonb,$5::timestamptz,$6::timestamptz)',[x.id,x.name,x.status,JSON.stringify(x),x.createdAt,x.updatedAt]);return clone(x);}
export async function migrateLegacyClients(pool){const c=await pool.connect();try{await c.query('BEGIN');await ensureClientTable(c);const selected=await c.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE FOR UPDATE');if(!selected.rows?.length)throw new Error('STATE_MISSING');const db=structuredClone(selected.rows[0].state||{}),items=Array.isArray(db.clients)?db.clients:[],dedicated=await readClients(c);if(!dedicated.length)for(const x of items)await insertClient(c,x);else if(items.length){const ids=new Set(dedicated.map(x=>x.id));if(items.some(x=>!ids.has(x.id)))throw new Error('CLIENT_MIGRATION_CONFLICT');}db.clients=[];await c.query('UPDATE central_juridica_state SET state=$1::jsonb,updated_at=now() WHERE singleton=TRUE',[JSON.stringify(db)]);await c.query('COMMIT');return{migrated:items.length};}catch(e){try{await c.query('ROLLBACK')}catch{}throw e}finally{c.release()}}
