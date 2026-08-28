import crypto from 'node:crypto';
import pg from 'pg';
import { appendAuditInTransaction, emptyAuditState, ensureAuditTables, readAuditState, seedAuditState } from '../src/postgres-audit-v2.mjs';
import { acquireIdempotencyLock, ensureIdempotencyTable, readIdempotencyResult, storeIdempotencyResult } from '../src/postgres-idempotency-v2-1.mjs';
import { ensureAgreementTable, findAgreementById, insertAgreement, migrateLegacyAgreements, readAgreements, updateAgreement } from '../src/postgres-agreements-v2-4.mjs';
import { verifyAudit } from '../src/audit-integrity-v1-6.mjs';

const url=process.env.CJ_DATABASE_URL;if(!url)throw new Error('CJ_DATABASE_URL ausente.');
const pool=new pg.Pool({connectionString:url,max:40}),phases=[];
const phase=(name,ok,extra={})=>{phases.push({name,ok,...extra});if(!ok)throw new Error(`Gate falhou: ${name}`);};
const idemSecret=crypto.randomBytes(32),auditKey=crypto.randomBytes(32),ring={activeKeyId:'agreement-audit',legacyKeyId:'agreement-audit',source:'ci',keys:new Map([['agreement-audit',auditKey]])};
const startedAt=new Date().toISOString(),now=()=>new Date().toISOString();
const audit=(id,action,entityId)=>({id,action,entity:'agreement',entityId,requestId:id,actor:{id:'u-ci',role:'admin'},detail:{gate:'v2.4'},at:now()});
const make=(id,amount=4800)=>({id,processId:'process-1',amount,direction:'Nossa proposta',status:'Em negociação',occurredAt:'2026-08-28',notes:'gate v2.4',createdBy:'u-ci',createdAt:now(),updatedAt:now()});

async function createAgreement(record,key=null){const c=await pool.connect();try{await c.query('BEGIN');let idem=null;if(key){idem=await acquireIdempotencyLock(c,'agreement',key,idemSecret);const replay=await readIdempotencyResult(c,idem.scope,idem.keyHash);if(replay!==null){await c.query('COMMIT');return{...replay,replayed:true};}}await appendAuditInTransaction(c,audit(`audit-create-${record.id}`,'CREATE',record.id),ring);await insertAgreement(c,record);const out={agreement:record};if(idem)await storeIdempotencyResult(c,idem.scope,idem.keyHash,out);await c.query('COMMIT');return out;}catch(e){try{await c.query('ROLLBACK');}catch{}throw e;}finally{c.release();}}
async function patchAgreement(record){const c=await pool.connect();try{await c.query('BEGIN');await appendAuditInTransaction(c,audit(`audit-update-${record.id}-${crypto.randomUUID()}`,'UPDATE',record.id),ring);const out=await updateAgreement(c,record);await c.query('COMMIT');return out;}catch(e){try{await c.query('ROLLBACK');}catch{}throw e;}finally{c.release();}}
async function withStateLocked(work,timeoutMs=5000){const c=await pool.connect();let timer;try{await c.query('BEGIN');await c.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE FOR UPDATE');return await Promise.race([Promise.resolve().then(work),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`STATE_LOCK_INDEPENDENCE_TIMEOUT_${timeoutMs}`)),timeoutMs);})]);}finally{if(timer)clearTimeout(timer);try{await c.query('ROLLBACK');}catch{}c.release();}}

try{
 const version=await pool.query('select version() as version');phase('postgres-connectivity',true,{version:version.rows[0].version});
 await pool.query(`CREATE TABLE IF NOT EXISTS central_juridica_state(singleton boolean PRIMARY KEY DEFAULT TRUE CHECK(singleton=TRUE),state jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())`);await pool.query('DELETE FROM central_juridica_state');
 const legacy=make('legacy-agreement',4000);await pool.query('INSERT INTO central_juridica_state(singleton,state) VALUES(TRUE,$1::jsonb)',[JSON.stringify({agreements:[legacy]})]);
 await ensureAuditTables(pool);await pool.query('DELETE FROM central_juridica_audit_log');await pool.query('DELETE FROM central_juridica_audit_meta');await seedAuditState(pool,emptyAuditState(ring),ring);
 await ensureIdempotencyTable(pool);await pool.query('DELETE FROM central_juridica_idempotency');await pool.query('DROP TABLE IF EXISTS central_juridica_agreements');
 const mig=await migrateLegacyAgreements(pool);phase('legacy-agreements-migrated',mig.migrated===1);
 const physical=(await pool.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE')).rows[0].state;phase('agreements-outside-jsonb',Array.isArray(physical.agreements)&&physical.agreements.length===0&&Boolean(await findAgreementById(pool,'legacy-agreement')));

 const noKey=make('no-key-agreement',4100);const noKeyResult=await withStateLocked(()=>createAgreement(noKey,null));phase('agreement-create-without-idempotency-key-outside-state-lock',noKeyResult.agreement?.id===noKey.id);
 const noKeyAudit=Number((await pool.query("SELECT count(*)::int n FROM central_juridica_audit_log WHERE payload->>'entityId'='no-key-agreement'")).rows[0].n);phase('agreement-no-key-audit-exactly-once',noKeyAudit===1,{auditRows:noKeyAudit});

 const shared=make('same-key-agreement',4800),writes=25,results=await Promise.all(Array.from({length:writes},()=>createAgreement(shared,'same-agreement-key')));const rows=Number((await pool.query("SELECT count(*)::int n FROM central_juridica_agreements WHERE agreement_id='same-key-agreement'")).rows[0].n),replayed=results.filter(r=>r.replayed).length;phase('agreement-idempotent-concurrency',rows===1&&replayed===24,{writers:writes,agreementRows:rows,replayed,duplicateCreates:rows-1});
 const auditSame=Number((await pool.query("SELECT count(*)::int n FROM central_juridica_audit_log WHERE payload->>'entityId'='same-key-agreement'")).rows[0].n);phase('agreement-audit-exactly-once',auditSame===1,{auditRows:auditSame});

 await withStateLocked(()=>Promise.all(Array.from({length:25},(_,i)=>createAgreement(make(`parallel-agreement-${i}`,5000+i),`parallel-agreement-key-${i}`))),10000);phase('parallel-agreement-writes-outside-state-lock',true,{writers:25});
 const current=await findAgreementById(pool,'no-key-agreement'),patched={...current,amount:5200,status:'Aceita',updatedAt:now()};const updated=await withStateLocked(()=>patchAgreement(patched));phase('agreement-update-independent-of-state-lock',updated.amount===5200&&updated.status==='Aceita');

 const before=(await readAuditState(pool)).auditLog.length;let failed=false;try{await patchAgreement(make('missing-agreement',1));}catch{failed=true;}const after=await readAuditState(pool);phase('agreement-update-rollback-includes-audit',failed&&after.auditLog.length===before&&verifyAudit(after,ring).ok===true);

 const logicalSnapshot=await readAgreements(pool);await pool.query('DELETE FROM central_juridica_agreements');for(const agreement of logicalSnapshot)await insertAgreement(pool,agreement);const restored=await readAgreements(pool);const physicalAfter=(await pool.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE')).rows[0].state;phase('agreement-table-snapshot-restore',restored.length===logicalSnapshot.length&&Array.isArray(physicalAfter.agreements)&&physicalAfter.agreements.length===0,{restoredAgreements:restored.length});
 phase('dedicated-agreement-indexed-store',restored.length===28,{totalAgreements:restored.length});
 const summary={dedicatedAgreementTable:true,agreementsOutsideJsonb:true,legacyMigration:true,noKeyCreateOutsideStateLock:true,createsOutsideStateLock:true,updatesOutsideStateLock:true,idempotentConcurrentRequests:25,idempotentAgreementCreates:1,idempotentReplays:24,parallelAgreementWriters:25,agreementAuditAtomicity:true,rollbackAuditAtomicity:true,snapshotRestore:true};
 console.log(JSON.stringify({ok:true,evidence:{runId:crypto.randomUUID(),startedAt,phases,finishedAt:new Date().toISOString(),summary}},null,2));
}catch(error){console.error(JSON.stringify({ok:false,evidence:{startedAt,phases},error:{name:error.name,message:error.message,stack:error.stack}},null,2));process.exitCode=1;}finally{await pool.end();}
