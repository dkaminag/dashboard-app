import crypto from 'node:crypto';
import pg from 'pg';
import { appendAuditInTransaction, emptyAuditState, ensureAuditTables, readAuditState, seedAuditState } from '../src/postgres-audit-v2.mjs';
import { acquireIdempotencyLock, ensureIdempotencyTable, readIdempotencyResult, storeIdempotencyResult } from '../src/postgres-idempotency-v2-1.mjs';
import { ensureDocumentMetadataTable, findDocumentByDigest, findDocumentById, insertDocumentMetadata, migrateLegacyDocuments, readDocuments } from '../src/postgres-documents-v2-9.mjs';
import { verifyAudit } from '../src/audit-integrity-v1-6.mjs';

const url=process.env.CJ_DATABASE_URL;if(!url)throw new Error('CJ_DATABASE_URL ausente.');
const pool=new pg.Pool({connectionString:url,max:60}),phases=[];const phase=(name,ok,extra={})=>{phases.push({name,ok,...extra});if(!ok)throw new Error(`Gate falhou: ${name}`);};
const idemSecret=crypto.randomBytes(32),auditKey=crypto.randomBytes(32),ring={activeKeyId:'document-audit',legacyKeyId:'document-audit',source:'ci',keys:new Map([['document-audit',auditKey]])};const startedAt=new Date().toISOString(),now=()=>new Date().toISOString();
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const make=(id,processId='process-1',plainSha=sha(Buffer.from(id)))=>{const createdAt=now();return{id,name:`${id}.pdf`,processId,mimeType:'application/pdf',size:123,sha256:plainSha,storedSha256:'0'.repeat(64),storageBackend:'postgres',storageName:null,encrypted:true,encryptionKeyId:'document-ci',uploadedBy:'u-ci',createdAt};};
const audit=(id,entityId)=>({id,action:'UPLOAD',entity:'document',entityId,requestId:id,actor:{id:'u-ci',role:'admin'},detail:{gate:'v2.9'},at:now()});

async function ensureBlobTable(q){await q.query(`CREATE TABLE IF NOT EXISTS central_juridica_document_blobs(document_id text PRIMARY KEY,payload bytea NOT NULL,stored_sha256 char(64) NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);}
async function createDocument(record,bytes,key=null,auditId=null){
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    let idem=null;
    if(key){idem=await acquireIdempotencyLock(c,'document',key,idemSecret);const replay=await readIdempotencyResult(c,idem.scope,idem.keyHash);if(replay!==null){await c.query('COMMIT');return{...replay,replayed:true};}}
    const storedSha256=sha(bytes),doc={...record,storedSha256};
    const inserted=await insertDocumentMetadata(c,doc,{onDuplicate:'ignore'});
    let out;
    if(!inserted.inserted){out={document:inserted.document,duplicate:true};}
    else {
      await c.query('INSERT INTO central_juridica_document_blobs(document_id,payload,stored_sha256) VALUES($1,$2,$3)',[doc.id,bytes,storedSha256]);
      await appendAuditInTransaction(c,audit(auditId||`audit-${doc.id}`,doc.id),ring);
      out={document:doc};
    }
    if(idem)await storeIdempotencyResult(c,idem.scope,idem.keyHash,out);
    await c.query('COMMIT');return out;
  }catch(e){try{await c.query('ROLLBACK');}catch{}throw e;}finally{c.release();}
}
async function withStateLocked(work,timeoutMs=7000){const c=await pool.connect();let timer;try{await c.query('BEGIN');await c.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE FOR UPDATE');return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`STATE_LOCK_INDEPENDENCE_TIMEOUT_${timeoutMs}`)),timeoutMs);})]);}finally{if(timer)clearTimeout(timer);try{await c.query('ROLLBACK');}catch{}c.release();}}

try{
  const version=await pool.query('select version() as version');phase('postgres-connectivity',true,{version:version.rows[0].version});
  await pool.query(`CREATE TABLE IF NOT EXISTS central_juridica_state(singleton boolean PRIMARY KEY DEFAULT TRUE CHECK(singleton=TRUE),state jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query('DELETE FROM central_juridica_state');await ensureBlobTable(pool);await pool.query('DELETE FROM central_juridica_document_blobs');
  const legacyBytes=Buffer.from('legacy-cipher'),legacy={...make('legacy-document','process-legacy'),storedSha256:sha(legacyBytes)};
  await pool.query('INSERT INTO central_juridica_state(singleton,state) VALUES(TRUE,$1::jsonb)',[JSON.stringify({documents:[legacy]})]);
  await pool.query('INSERT INTO central_juridica_document_blobs(document_id,payload,stored_sha256) VALUES($1,$2,$3)',[legacy.id,legacyBytes,legacy.storedSha256]);
  await ensureAuditTables(pool);await pool.query('DELETE FROM central_juridica_audit_log');await pool.query('DELETE FROM central_juridica_audit_meta');await seedAuditState(pool,emptyAuditState(ring),ring);
  await ensureIdempotencyTable(pool);await pool.query('DELETE FROM central_juridica_idempotency');await pool.query('DROP TABLE IF EXISTS central_juridica_documents');
  const mig=await migrateLegacyDocuments(pool);phase('legacy-document-metadata-migrated',mig.migrated===1);
  const physical=(await pool.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE')).rows[0].state;phase('document-metadata-outside-jsonb',Array.isArray(physical.documents)&&physical.documents.length===0&&Boolean(await findDocumentById(pool,'legacy-document')));

  const noKey=make('no-key-document','process-a'),noKeyBytes=Buffer.from('cipher-no-key');const noKeyResult=await withStateLocked(()=>createDocument(noKey,noKeyBytes));phase('document-upload-without-idempotency-key-outside-state-lock',noKeyResult.document?.id===noKey.id);
  const noKeyBlob=await pool.query('SELECT stored_sha256,payload FROM central_juridica_document_blobs WHERE document_id=$1',[noKey.id]);phase('document-metadata-blob-atomic-write',noKeyBlob.rows.length===1&&sha(noKeyBlob.rows[0].payload)===String(noKeyBlob.rows[0].stored_sha256).trim());
  const noKeyAudit=Number((await pool.query("SELECT count(*)::int n FROM central_juridica_audit_log WHERE payload->>'entityId'='no-key-document' AND payload->>'action'='UPLOAD'")).rows[0].n);phase('document-audit-exactly-once',noKeyAudit===1,{auditRows:noKeyAudit});

  const shared=make('same-key-document','process-b'),sharedBytes=Buffer.from('cipher-same-key'),writes=25,results=await Promise.all(Array.from({length:writes},()=>createDocument(shared,sharedBytes,'same-document-key')));
  const metaRows=Number((await pool.query("SELECT count(*)::int n FROM central_juridica_documents WHERE document_id='same-key-document'")).rows[0].n),blobRows=Number((await pool.query("SELECT count(*)::int n FROM central_juridica_document_blobs WHERE document_id='same-key-document'")).rows[0].n),replayed=results.filter(r=>r.replayed).length;
  phase('document-idempotent-concurrency',metaRows===1&&blobRows===1&&replayed===24,{writers:writes,metadataRows:metaRows,blobRows,replayed,duplicateCreates:metaRows-1});

  const dupBase=make('dedupe-base','process-dedupe','a'.repeat(64)),dupBytes=Buffer.from('dedupe-one');await createDocument(dupBase,dupBytes);
  const auditBefore=Number((await pool.query("SELECT count(*)::int n FROM central_juridica_audit_log WHERE payload->>'entityId'='dedupe-base'")).rows[0].n),blobsBefore=Number((await pool.query("SELECT count(*)::int n FROM central_juridica_document_blobs WHERE document_id IN ('dedupe-base','dedupe-second')")).rows[0].n);
  const dupResult=await createDocument(make('dedupe-second','process-dedupe','a'.repeat(64)),Buffer.from('should-not-persist'));
  const blobsAfter=Number((await pool.query("SELECT count(*)::int n FROM central_juridica_document_blobs WHERE document_id IN ('dedupe-base','dedupe-second')")).rows[0].n),auditDup=Number((await pool.query("SELECT count(*)::int n FROM central_juridica_audit_log WHERE payload->>'entityId' IN ('dedupe-base','dedupe-second')")).rows[0].n);
  phase('document-dedup-no-orphan-blob',dupResult.duplicate===true&&dupResult.document.id==='dedupe-base'&&blobsBefore===1&&blobsAfter===1&&auditBefore===1&&auditDup===1);

  await withStateLocked(()=>Promise.all(Array.from({length:25},(_,i)=>createDocument(make(`parallel-doc-${i}`,`process-par-${i}`),Buffer.from(`parallel-cipher-${i}`),`parallel-doc-key-${i}`))),12000);phase('parallel-document-writes-outside-state-lock',true,{writers:25});

  const rb1=make('rollback-seed','process-rb-a'),rb1Bytes=Buffer.from('rb-one');await createDocument(rb1,rb1Bytes,null,'audit-rollback-fixed');
  let rollbackOk=false;try{await createDocument(make('rollback-target','process-rb-b'),Buffer.from('rb-two'),null,'audit-rollback-fixed');}catch{const m=await findDocumentById(pool,'rollback-target'),b=await pool.query("SELECT count(*)::int n FROM central_juridica_document_blobs WHERE document_id='rollback-target'");rollbackOk=!m&&Number(b.rows[0].n)===0;}phase('document-audit-failure-rolls-back-metadata-and-blob',rollbackOk);

  const allMeta=await readDocuments(pool),allBlobs=(await pool.query('SELECT document_id,payload,stored_sha256 FROM central_juridica_document_blobs ORDER BY document_id')).rows;
  const metaById=new Map(allMeta.map(x=>[x.id,x]));const consistent=allBlobs.every(b=>metaById.has(b.document_id)&&String(metaById.get(b.document_id).storedSha256)===String(b.stored_sha256).trim()&&sha(b.payload)===String(b.stored_sha256).trim())&&allMeta.filter(x=>x.storageBackend==='postgres').every(x=>allBlobs.some(b=>b.document_id===x.id));phase('document-snapshot-consistency',consistent,{metadata:allMeta.length,blobs:allBlobs.length});
  await pool.query('DELETE FROM central_juridica_document_blobs');await pool.query('DELETE FROM central_juridica_documents');for(const m of allMeta)await insertDocumentMetadata(pool,m);for(const b of allBlobs)await pool.query('INSERT INTO central_juridica_document_blobs(document_id,payload,stored_sha256) VALUES($1,$2,$3)',[b.document_id,b.payload,String(b.stored_sha256).trim()]);
  const restoredMeta=await readDocuments(pool),restoredBlobs=Number((await pool.query('SELECT count(*)::int n FROM central_juridica_document_blobs')).rows[0].n);phase('document-tables-snapshot-restore',restoredMeta.length===allMeta.length&&restoredBlobs===allBlobs.length,{restoredMetadata:restoredMeta.length,restoredBlobs});
  const auditState=await readAuditState(pool);phase('audit-chain-valid-after-document-gate',verifyAudit(auditState,ring).ok===true);

  const summary={dedicatedDocumentMetadataTable:true,documentMetadataOutsideJsonb:true,legacyMigration:true,noKeyUploadOutsideStateLock:true,metadataBlobAtomicity:true,idempotentConcurrentRequests:25,idempotentDocumentCreates:1,idempotentReplays:24,dedupNoOrphanBlob:true,parallelDocumentWriters:25,rollbackAtomicity:true,snapshotConsistency:true,snapshotRestore:true,auditChainValid:true};
  console.log(JSON.stringify({ok:true,evidence:{runId:crypto.randomUUID(),startedAt,phases,finishedAt:new Date().toISOString(),summary}},null,2));
}catch(error){console.error(JSON.stringify({ok:false,evidence:{startedAt,phases},error:{name:error.name,message:error.message,code:error.code,stack:error.stack}},null,2));process.exitCode=1;}finally{await pool.end();}