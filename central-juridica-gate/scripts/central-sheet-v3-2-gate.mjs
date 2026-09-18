import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { ensureCentralSheetSchema, syncCentralSheetDataset, getCentralSheetSyncStatus } from '../src/postgres-central-sheet-v3-2.mjs';
import { readClients, insertClient } from '../src/postgres-clients-v2-9.mjs';
import { readProcesses, insertProcess } from '../src/postgres-processes-v2-3.mjs';
import { readTasks } from '../src/postgres-tasks-v2-2.mjs';
import { readExecutionActions } from '../src/postgres-executions-v2-5.mjs';
import { ensureAuditTables, readAuditState } from '../src/postgres-audit-v2.mjs';

const {Pool}=pg;
const pool=new Pool({connectionString:process.env.CJ_DATABASE_URL,max:20});
const key=crypto.createHash('sha256').update('central-sheet-gate-audit').digest();
const auditRing={activeKeyId:'gate-audit',legacyKeyId:'gate-audit',source:'gate',keys:new Map([['gate-audit',key]])};
const spreadsheetId='sheet-central-gate', now='2026-09-18T12:00:00.000Z';
const src=(sheetName,sourceKey,rowNumber,rowHash)=>({centralSheet:{spreadsheetId,sheetName,sourceKey,rowNumber,rowHash,syncedAt:now}});
const h=v=>crypto.createHash('sha256').update(v).digest('hex');
function dataset(suffix='v1',title='Execução Panorama'){
 const clientId='cli_sheet_gate', processId='proc_sheet_gate';
 return {warnings:[],clients:[{id:clientId,name:'Panorama Materiais de Construção',type:'Empresa',status:'Ativo',createdAt:now,updatedAt:now,source:src('Processos','Panorama Materiais de Construção',2,h('client-'+suffix))}],processes:[{id:processId,number:'0020605-79.2025.8.16.0030',title,clientId,area:'Cível',stage:'Execução',status:'Em análise',risk:'Médio',requestedValue:null,nextDeadline:null,nextAction:'Acompanhar PREVJUD',owner:'',facts:'RAW_SENTINEL_CONTENT',evidence:'Decisão',strategy:'Acompanhar',createdAt:now,updatedAt:now,source:src('Processos','CNJ|0020605-79.2025.8.16.0030',2,h('process-'+suffix))}],tasks:[{id:'tsk_sheet_gate',title:'Prazo: Conferir autos',processId,priority:'Alta',dueDate:'2026-09-30',status:'Pendente',owner:'',createdAt:now,updatedAt:now,source:src('Prazos_Audiencias','CNJ|0020605-79.2025.8.16.0030|prazo',2,h('task-'+suffix))}],executions:[{id:'exe_sheet_gate',processId,measure:'SISBAJUD',status:'Em andamento',requestedAt:null,reviewDate:null,result:'Parcial',notes:'evento 110.1',createdAt:now,updatedAt:now,source:src('Execucoes','CNJ|0020605-79.2025.8.16.0030|SISBAJUD',2,h('exec-'+suffix))}],references:{},source:{spreadsheetId,syncedAt:now,readOnly:true}};
}
const phases=[], phase=(name,extra={})=>phases.push({name,ok:true,...extra});
try{
 const c=await pool.connect();
 try{
  const v=await c.query('select version()'); phase('postgres-connectivity',{version:v.rows[0].version});
  await c.query(`CREATE TABLE IF NOT EXISTS central_juridica_state(singleton boolean PRIMARY KEY DEFAULT TRUE CHECK(singleton=TRUE),state jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())`);
  await c.query(`INSERT INTO central_juridica_state(singleton,state) VALUES(TRUE,'{}'::jsonb) ON CONFLICT(singleton) DO UPDATE SET state='{}'::jsonb,updated_at=now()`);
  await ensureCentralSheetSchema(c); await ensureAuditTables(c);
  await c.query('TRUNCATE central_juridica_sheet_sources,central_juridica_sheet_sync_runs,central_juridica_execution_actions,central_juridica_tasks,central_juridica_processes,central_juridica_clients,central_juridica_audit_log,central_juridica_audit_meta RESTART IDENTITY');
  phase('central-sheet-schema-ready');
 } finally { c.release(); }

 const preview=await syncCentralSheetDataset(pool,dataset(),{spreadsheetId,mode:'preview',syncId:'sync-preview',auditRing,actorId:'gate'});
 assert.equal(preview.applied,false);
 const q0=await pool.query(`SELECT (SELECT count(*) FROM central_juridica_clients)::int clients,(SELECT count(*) FROM central_juridica_processes)::int processes,(SELECT count(*) FROM central_juridica_tasks)::int tasks,(SELECT count(*) FROM central_juridica_execution_actions)::int executions,(SELECT count(*) FROM central_juridica_sheet_sync_runs)::int syncs,(SELECT count(*) FROM central_juridica_sheet_sources)::int sources`);
 assert.deepEqual(q0.rows[0],{clients:0,processes:0,tasks:0,executions:0,syncs:0,sources:0}); phase('preview-rollback-zero-writes');

 const locker=await pool.connect(); await locker.query('BEGIN'); await locker.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE FOR UPDATE');
 const boot=await Promise.race([
   syncCentralSheetDataset(pool,dataset(),{spreadsheetId,spreadsheetTitle:'Central Jurídica - Brito & Peovezan',mode:'bootstrap',syncId:'sync-boot',auditRing,actorId:'gate',requestId:'req-boot'}),
   new Promise((_,reject)=>setTimeout(()=>reject(new Error('CENTRAL_SHEET_SYNC_BLOCKED_BY_SINGLETON')),1500))
 ]);
 await locker.query('ROLLBACK'); locker.release();
 assert.equal(boot.counts.clientsCreated,1); assert.equal(boot.counts.processesCreated,1); phase('bootstrap-independent-of-singleton-lock');

 let clients=await readClients(pool), processes=await readProcesses(pool), tasks=await readTasks(pool), execs=await readExecutionActions(pool);
 assert.equal(clients.length,1); assert.equal(processes.length,1); assert.equal(tasks.length,1); assert.equal(execs.length,1);
 phase('bootstrap-core-entities-created',{clients:1,processes:1,tasks:1,executions:1});

 const cols=await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='central_juridica_sheet_sources' ORDER BY ordinal_position`);
 assert.deepEqual(cols.rows.map(x=>x.column_name),['spreadsheet_id','sheet_name','source_key','row_number','row_hash','domain_entity','domain_id','synced_at']);
 const prov=await pool.query('SELECT * FROM central_juridica_sheet_sources');
 assert.equal(JSON.stringify(prov.rows).includes('RAW_SENTINEL_CONTENT'),false); phase('provenance-metadata-only',{sourceRows:prov.rowCount});

 const replay=await syncCentralSheetDataset(pool,dataset(),{spreadsheetId,mode:'refresh',syncId:'sync-replay',auditRing,actorId:'gate'});
 clients=await readClients(pool); processes=await readProcesses(pool); tasks=await readTasks(pool); execs=await readExecutionActions(pool);
 assert.equal(clients.length,1); assert.equal(processes.length,1); assert.equal(tasks.length,1); assert.equal(execs.length,1);
 assert.equal(replay.counts.processesCreated,0); assert.equal(replay.counts.tasksCreated,0); assert.equal(replay.counts.executionsCreated,0);
 assert.equal(replay.counts.processesUpdated,0); assert.equal(replay.counts.tasksUpdated,0); assert.equal(replay.counts.executionsUpdated,0);
 phase('replay-idempotent-no-duplicates',{skipped:replay.counts.skipped});

 const changed=await syncCentralSheetDataset(pool,dataset('v2','Execução Panorama Atualizada'),{spreadsheetId,mode:'refresh',syncId:'sync-changed',auditRing,actorId:'gate'});
 processes=await readProcesses(pool);
 assert.equal(processes.find(x=>x.id==='proc_sheet_gate').title,'Execução Panorama Atualizada');
 assert.equal(changed.counts.processesUpdated,1); phase('row-hash-change-updates-sheet-owned');

 await insertClient(pool,{id:'cli-manual',name:'Cliente Manual',type:'Empresa',status:'Ativo',createdAt:now,updatedAt:now});
 const manual={id:'proc-manual',number:'9999999-99.2026.8.16.0030',title:'Título Manual Preservar',clientId:'cli-manual',area:'Cível',stage:'Conhecimento',status:'Ativo',risk:'Médio',requestedValue:null,nextDeadline:null,nextAction:'Manual',owner:'Advogada',facts:'manual',evidence:'',strategy:'',createdAt:now,updatedAt:now};
 await insertProcess(pool,manual);
 const d=dataset('v3'); d.processes=[{...d.processes[0],id:'proc_sheet_other',number:manual.number,title:'Título da planilha não deve sobrescrever',clientId:d.clients[0].id,source:src('Processos','CNJ|'+manual.number,3,h('manual-match'))}]; d.tasks=[]; d.executions=[];
 await syncCentralSheetDataset(pool,d,{spreadsheetId,mode:'refresh',syncId:'sync-manual',auditRing,actorId:'gate'});
 assert.equal((await readProcesses(pool)).find(x=>x.id==='proc-manual').title,'Título Manual Preservar'); phase('manual-process-not-overwritten');

 const status=await getCentralSheetSyncStatus(pool,spreadsheetId); assert.equal(status.status,'success'); assert.equal(status.sync_id,'sync-manual'); phase('last-sync-status-success');
 const audit=await readAuditState(pool); const syncAudits=audit.auditLog.filter(x=>x.action==='CENTRAL_SHEET_SYNC_APPLIED'); assert.equal(syncAudits.length,4); phase('audit-exactly-once-per-applied-sync',{auditRows:syncAudits.length});
 const syncRows=await pool.query('SELECT count(*)::int n FROM central_juridica_sheet_sync_runs'); assert.equal(syncRows.rows[0].n,4); phase('applied-sync-history',{syncRuns:4});

 console.log(JSON.stringify({ok:true,evidence:{phases,summary:{previewZeroWrites:true,bootstrapOutsideSingletonLock:true,idempotentReplay:true,metadataOnlyProvenance:true,rowHashRefresh:true,manualRecordsPreserved:true,auditExactlyOnce:true}}},null,2));
} catch(e) { console.error(e); process.exitCode=1; } finally { await pool.end(); }
