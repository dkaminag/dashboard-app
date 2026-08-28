import crypto from 'node:crypto';
import pg from 'pg';
import { appendAuditInTransaction, emptyAuditState, ensureAuditTables, readAuditState, seedAuditState } from '../src/postgres-audit-v2.mjs';
import { acquireIdempotencyLock, ensureIdempotencyTable, readIdempotencyResult, storeIdempotencyResult } from '../src/postgres-idempotency-v2-1.mjs';
import { ensureTaskTable, findTaskById, insertTask, migrateLegacyTasks, readTasks, updateTask } from '../src/postgres-tasks-v2-2.mjs';
import { verifyAudit } from '../src/audit-integrity-v1-6.mjs';

const url=process.env.CJ_DATABASE_URL;if(!url)throw new Error('CJ_DATABASE_URL ausente.');
const pool=new pg.Pool({connectionString:url,max:40});const phases=[];const phase=(name,ok,extra={})=>{phases.push({name,ok,...extra});if(!ok)throw new Error(`Gate falhou: ${name}`);};
const secret=crypto.randomBytes(32),auditKey=crypto.randomBytes(32),ring={activeKeyId:'tasks-audit',legacyKeyId:'tasks-audit',source:'ci',keys:new Map([['tasks-audit',auditKey]])};
const startedAt=new Date().toISOString();
const now=()=>new Date().toISOString();
const audit=(id,action,entityId)=>({id,action,entity:'task',entityId,requestId:id,actor:{id:'u-ci',role:'admin'},detail:{gate:'v2.2'},at:now()});

async function createTask(task,key){const c=await pool.connect();try{await c.query('BEGIN');let idem=null;if(key){idem=await acquireIdempotencyLock(c,'task',key,secret);const replay=await readIdempotencyResult(c,idem.scope,idem.keyHash);if(replay!==null){await c.query('COMMIT');return{...replay,replayed:true};}}await appendAuditInTransaction(c,audit(`audit-create-${task.id}`,'CREATE',task.id),ring);await insertTask(c,task);const out={task};if(idem)await storeIdempotencyResult(c,idem.scope,idem.keyHash,out);await c.query('COMMIT');return out;}catch(e){try{await c.query('ROLLBACK');}catch{}throw e;}finally{c.release();}}
async function patchTask(task){const c=await pool.connect();try{await c.query('BEGIN');await appendAuditInTransaction(c,audit(`audit-update-${task.id}-${crypto.randomUUID()}`,'UPDATE',task.id),ring);const out=await updateTask(c,task);await c.query('COMMIT');return out;}catch(e){try{await c.query('ROLLBACK');}catch{}throw e;}finally{c.release();}}

try{
 const version=await pool.query('select version() as version');phase('postgres-connectivity',true,{version:version.rows[0].version});
 await pool.query(`CREATE TABLE IF NOT EXISTS central_juridica_state(singleton boolean PRIMARY KEY DEFAULT TRUE CHECK(singleton=TRUE),state jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())`);
 await pool.query('DELETE FROM central_juridica_state');
 const legacyTime='2026-08-28T09:00:00.000Z',legacy={id:'legacy-task',title:'Legacy',processId:null,priority:'Média',dueDate:null,status:'Pendente',owner:'',createdAt:legacyTime,updatedAt:legacyTime};
 await pool.query('INSERT INTO central_juridica_state(singleton,state) VALUES(TRUE,$1::jsonb)',[JSON.stringify({tasks:[legacy]})]);
 await ensureAuditTables(pool);await pool.query('DELETE FROM central_juridica_audit_log');await pool.query('DELETE FROM central_juridica_audit_meta');await seedAuditState(pool,emptyAuditState(ring),ring);
 await ensureIdempotencyTable(pool);await pool.query('DELETE FROM central_juridica_idempotency');await pool.query('DROP TABLE IF EXISTS central_juridica_tasks');
 const mig=await migrateLegacyTasks(pool);phase('legacy-tasks-migrated',mig.migrated===1);
 const physical=(await pool.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE')).rows[0].state;phase('tasks-outside-jsonb',Array.isArray(physical.tasks)&&physical.tasks.length===0&&Boolean(await findTaskById(pool,'legacy-task')));

 const lock=await pool.connect();await lock.query('BEGIN');await lock.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE FOR UPDATE');
 const independentTask={id:'independent-task',title:'Sem lock global',processId:null,priority:'Alta',dueDate:null,status:'Pendente',owner:'',createdAt:now(),updatedAt:now()};
 const independent=await Promise.race([createTask(independentTask,'independent-key').then(()=>true),new Promise(r=>setTimeout(()=>r(false),1500))]);phase('task-create-independent-of-state-lock',independent===true);await lock.query('ROLLBACK');lock.release();

 const shared={id:'same-key-task',title:'Exactly once',processId:null,priority:'Alta',dueDate:'2026-08-29',status:'Pendente',owner:'',createdAt:now(),updatedAt:now()};
 const writes=25,results=await Promise.all(Array.from({length:writes},()=>createTask(shared,'same-task-key')));const sameRows=Number((await pool.query("SELECT count(*)::int n FROM central_juridica_tasks WHERE task_id='same-key-task'")).rows[0].n);const replayed=results.filter(r=>r.replayed).length;phase('task-idempotent-concurrency',sameRows===1&&replayed===24,{writers:writes,taskRows:sameRows,replayed,duplicateCreates:sameRows-1});
 const auditSame=Number((await pool.query("SELECT count(*)::int n FROM central_juridica_audit_log WHERE payload->>'entityId'='same-key-task'")).rows[0].n);phase('task-audit-exactly-once',auditSame===1,{auditRows:auditSame});

 const parallelLock=await pool.connect();await parallelLock.query('BEGIN');await parallelLock.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE FOR UPDATE');
 const parallel=await Promise.race([Promise.all(Array.from({length:25},(_,i)=>{const t={id:`parallel-task-${i}`,title:`Parallel ${i}`,processId:null,priority:'Média',dueDate:null,status:'Pendente',owner:'',createdAt:now(),updatedAt:now()};return createTask(t,`parallel-key-${i}`);})).then(()=>true),new Promise(r=>setTimeout(()=>r(false),3000))]);phase('parallel-task-writes-outside-state-lock',parallel===true,{writers:25});await parallelLock.query('ROLLBACK');parallelLock.release();

 const current=await findTaskById(pool,'independent-task');const patched={...current,title:'Atualizada sem singleton',updatedAt:now()};const updateLock=await pool.connect();await updateLock.query('BEGIN');await updateLock.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE FOR UPDATE');const updated=await Promise.race([patchTask(patched).then(t=>t.title==='Atualizada sem singleton'),new Promise(r=>setTimeout(()=>r(false),1500))]);phase('task-update-independent-of-state-lock',updated===true);await updateLock.query('ROLLBACK');updateLock.release();

 const beforeAudit=(await readAuditState(pool)).auditLog.length;let failed=false;try{await patchTask({id:'missing-task',title:'x',processId:null,status:'Pendente',createdAt:now(),updatedAt:now()});}catch{failed=true;}const afterAuditState=await readAuditState(pool);phase('task-update-rollback-includes-audit',failed&&afterAuditState.auditLog.length===beforeAudit&&verifyAudit(afterAuditState,ring).ok===true);
 const totalTasks=(await readTasks(pool)).length;phase('dedicated-task-indexed-store',totalTasks===28,{totalTasks});
 const summary={dedicatedTaskTable:true,tasksOutsideJsonb:true,legacyMigration:true,createsOutsideStateLock:true,updatesOutsideStateLock:true,idempotentConcurrentRequests:25,idempotentTaskCreates:1,idempotentReplays:24,parallelTaskWriters:25,taskAuditAtomicity:true,rollbackAuditAtomicity:true};
 console.log(JSON.stringify({ok:true,evidence:{runId:crypto.randomUUID(),startedAt,phases,finishedAt:new Date().toISOString(),summary}},null,2));
}finally{await pool.end();}
