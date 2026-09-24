const clone = value => structuredClone(value);

export async function ensureDocumentMetadataTable(q) {
  await q.query(`CREATE TABLE IF NOT EXISTS central_juridica_documents (
    document_id text PRIMARY KEY,
    process_id text NOT NULL,
    name text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL CHECK(size_bytes >= 0),
    sha256 char(64) NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
    stored_sha256 char(64) NOT NULL CHECK(stored_sha256 ~ '^[0-9a-f]{64}$'),
    storage_backend text NOT NULL,
    storage_name text NULL,
    encrypted boolean NOT NULL DEFAULT false,
    encryption_key_id text NULL,
    uploaded_by text NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    UNIQUE(process_id, sha256)
  )`);
  await q.query('CREATE INDEX IF NOT EXISTS central_juridica_documents_process_created_idx ON central_juridica_documents(process_id, created_at DESC)');
  await q.query('CREATE INDEX IF NOT EXISTS central_juridica_documents_created_idx ON central_juridica_documents(created_at DESC)');
}
export async function readDocuments(q){const r=await q.query('SELECT payload FROM central_juridica_documents ORDER BY created_at DESC, document_id DESC');return(r.rows||[]).map(x=>clone(x.payload));}
export async function findDocumentById(q,id){const r=await q.query('SELECT payload FROM central_juridica_documents WHERE document_id=$1',[id]);return r.rows?.length?clone(r.rows[0].payload):null;}
export async function findDocumentByDigest(q,processId,sha256){const r=await q.query('SELECT payload FROM central_juridica_documents WHERE process_id=$1 AND sha256=$2',[processId,sha256]);return r.rows?.length?clone(r.rows[0].payload):null;}
const vals=x=>[x.id,x.processId,x.name,x.mimeType,Number(x.size||0),x.sha256,x.storedSha256,x.storageBackend||'postgres',x.storageName||null,Boolean(x.encrypted),x.encryptionKeyId||null,x.uploadedBy||null,JSON.stringify(x),x.createdAt];
export async function insertDocumentMetadata(q,x,{onDuplicate='error'}={}){const suffix=onDuplicate==='ignore'?' ON CONFLICT(process_id,sha256) DO NOTHING RETURNING payload':' RETURNING payload';const r=await q.query(`INSERT INTO central_juridica_documents(document_id,process_id,name,mime_type,size_bytes,sha256,stored_sha256,storage_backend,storage_name,encrypted,encryption_key_id,uploaded_by,payload,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::timestamptz)${suffix}`,vals(x));if(onDuplicate==='ignore'&&!r.rows?.length)return{inserted:false,document:await findDocumentByDigest(q,x.processId,x.sha256)};return{inserted:true,document:clone(r.rows?.[0]?.payload||x)};}
export async function migrateLegacyDocuments(pool){const c=await pool.connect();try{await c.query('BEGIN');await ensureDocumentMetadataTable(c);const selected=await c.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE FOR UPDATE');if(!selected.rows?.length)throw new Error('STATE_MISSING');const db=structuredClone(selected.rows[0].state||{}),items=Array.isArray(db.documents)?db.documents:[],dedicated=await readDocuments(c);if(!dedicated.length)for(const x of items)await insertDocumentMetadata(c,x);else if(items.length){const ids=new Set(dedicated.map(x=>x.id));if(items.some(x=>!ids.has(x.id)))throw new Error('DOCUMENT_METADATA_MIGRATION_CONFLICT');}db.documents=[];await c.query('UPDATE central_juridica_state SET state=$1::jsonb,updated_at=now() WHERE singleton=TRUE',[JSON.stringify(db)]);await c.query('COMMIT');return{migrated:items.length};}catch(e){try{await c.query('ROLLBACK');}catch{}throw e;}finally{c.release();}}