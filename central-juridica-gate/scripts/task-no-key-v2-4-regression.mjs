import crypto from 'node:crypto';
import pg from 'pg';
import { appendAuditInTransaction, emptyAuditState, ensureAuditTables, seedAuditState } from '../src/postgres-audit-v2.mjs';
import { ensureTaskTable, insertTask } from '../src/postgres-tasks-v2-2.mjs';

const url=process.env.CJ_DATABASE_URL;if(!url)throw new Error('CJ_DATABASE_URL ausente.');
const pool=new pg.Pool({connectionString:url,max:8});
const auditKey=crypto.randomBytes(32),ring={activeKeyId:'task-no-key-audit',legacyKeyId:'task-no-key-audit',source:'ci',keys:new Map([['task-no-key-audit',auditKey]])};
const now=()=>new Date().toISOString();

async function createWithoutKey(task){const c=await pool.connect();try{await c.query('BEGIN');await appendAuditInTransaction(c,{id:`audit-${task.id}`,action:'CREATE',entity:'task',entityId:task.id,requestId:'task-no-key-regression',actor:{id:'u-ci',role:'admin'},detail:{gate:'v2.4-regression'},at:now()},ring);await insertTask(c,task);await c.query('COMMIT');}catch(e){try{await c.query('ROLLBACK');}catch{}throw e;}finally{c.release();}}

try{
 await pool.query(`CREATE TABLE IF NOT EXISTS central_juridica_state(singleton boolean PRIMARY KEY DEFAULT TRUE CHECK(singleton=TRUE),state jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())`);await pool.query('DELETE FROM central_juridica_state');await pool.query('INSERT INTO central_juridica_state(singleton,state) VALUES(TRUE,$1::jsonb)',[JSON.stringify({tasks:[]})]);
 await ensureAuditTables(pool);await pool.query('DELETE FROM central_juridica_audit_log');await pool.query('DELETE FROM central_juridica_audit_meta');await seedAuditState(pool,emptyAuditState(ring),ring);await pool.query('DROP TABLE IF EXISTS central_juridica_tasks');await ensureTaskTable(pool);
 const lock=await pool.connect();try{await lock.query('BEGIN');await lock.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE FOR UPDATE');const task={id:'task-without-idem-key',title:'Sem Idempotency-Key',processId:null,priority:'Alta',dueDate:null,status:'Pendente',owner:'',createdAt:now(),updatedAt:now()};await Promise.race([createWithoutKey(task),new Promise((_,reject)=>setTimeout(()=>reject(new Error('TASK_NO_KEY_BLOCKED_BY_STATE_LOCK')),5000))]);const rows=Number((await pool.query("SELECT count(*)::int n FROM central_juridica_tasks WHERE task_id='task-without-idem-key'")).rows[0].n);const physical=(await pool.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE')).rows[0].state;const audits=Number((await pool.query("SELECT count(*)::int n FROM central_juridica_audit_log WHERE payload->>'entityId'='task-without-idem-key'")).rows[0].n);if(rows!==1||!Array.isArray(physical.tasks)||physical.tasks.length!==0||audits!==1)throw new Error('TASK_NO_KEY_DEDICATED_REGRESSION_FAILED');console.log(JSON.stringify({ok:true,summary:{taskWithoutIdempotencyKeyOutsideStateLock:true,taskRows:rows,jsonbTasks:physical.tasks.length,auditRows:audits}},null,2));}finally{try{await lock.query('ROLLBACK');}catch{}lock.release();}
}catch(error){console.error(JSON.stringify({ok:false,error:{name:error.name,message:error.message}},null,2));process.exitCode=1;}finally{await pool.end();}
