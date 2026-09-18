import { ensureClientTable, readClients, insertClient } from './postgres-clients-v2-9.mjs';
import { ensureProcessTable, readProcesses, insertProcess, updateProcess } from './postgres-processes-v2-3.mjs';
import { ensureTaskTable, readTasks, insertTask, updateTask } from './postgres-tasks-v2-2.mjs';
import { ensureExecutionTable, readExecutionActions, insertExecutionAction, updateExecutionAction } from './postgres-executions-v2-5.mjs';
import { ensureAuditTables, appendAuditInTransaction } from './postgres-audit-v2.mjs';

export async function ensureCentralSheetSchema(q) {
  await ensureClientTable(q); await ensureProcessTable(q); await ensureTaskTable(q); await ensureExecutionTable(q); await ensureAuditTables(q);
  await q.query(`CREATE TABLE IF NOT EXISTS central_juridica_sheet_sync_runs(
    sync_id text PRIMARY KEY, spreadsheet_id text NOT NULL, spreadsheet_title text NULL,
    mode text NOT NULL, status text NOT NULL, started_at timestamptz NOT NULL, finished_at timestamptz NULL,
    counts jsonb NOT NULL DEFAULT '{}'::jsonb, warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
    actor_id text NULL, request_id text NULL
  )`);
  await q.query('CREATE INDEX IF NOT EXISTS central_juridica_sheet_sync_runs_sheet_time_idx ON central_juridica_sheet_sync_runs(spreadsheet_id,started_at DESC)');
  await q.query(`CREATE TABLE IF NOT EXISTS central_juridica_sheet_sources(
    spreadsheet_id text NOT NULL, sheet_name text NOT NULL, source_key text NOT NULL,
    row_number integer NOT NULL, row_hash char(64) NOT NULL, domain_entity text NOT NULL, domain_id text NOT NULL,
    synced_at timestamptz NOT NULL, PRIMARY KEY(spreadsheet_id,sheet_name,source_key)
  )`);
  await q.query('CREATE INDEX IF NOT EXISTS central_juridica_sheet_sources_domain_idx ON central_juridica_sheet_sources(domain_entity,domain_id)');
}

export async function getCentralSheetSyncStatus(q, spreadsheetId) {
  const r=await q.query(`SELECT sync_id,spreadsheet_id,spreadsheet_title,mode,status,started_at,finished_at,counts,warnings,actor_id,request_id
    FROM central_juridica_sheet_sync_runs WHERE spreadsheet_id=$1 ORDER BY started_at DESC LIMIT 1`,[spreadsheetId]);
  return r.rows?.[0]||null;
}

export async function syncCentralSheetDataset(pool,dataset,{spreadsheetId,spreadsheetTitle=null,mode='preview',syncId,actorId=null,requestId=null,auditRing=null}={}){
  const apply=mode==='bootstrap'||mode==='refresh';
  if(!['preview','bootstrap','refresh'].includes(mode))throw new Error('CENTRAL_SHEET_MODE_INVALID');
  const c=await pool.connect(); const startedAt=new Date().toISOString();
  const counts={clientsCreated:0,processesCreated:0,processesUpdated:0,tasksCreated:0,tasksUpdated:0,executionsCreated:0,executionsUpdated:0,skipped:0};
  try{
    await c.query('BEGIN'); await ensureCentralSheetSchema(c);
    const clientIdMap=new Map(); const existingClients=await readClients(c); const byClientName=new Map(existingClients.map(x=>[norm(x.name),x]));
    for(const incoming of dataset.clients||[]){const existing=byClientName.get(norm(incoming.name));if(existing){clientIdMap.set(incoming.id,existing.id);counts.skipped++;await sourceUpsert(c,spreadsheetId,{...incoming,id:existing.id},'client');continue;}await insertClient(c,incoming);byClientName.set(norm(incoming.name),incoming);clientIdMap.set(incoming.id,incoming.id);counts.clientsCreated++;await sourceUpsert(c,spreadsheetId,incoming,'client');}
    const existingProcesses=await readProcesses(c);const byPid=new Map(existingProcesses.map(x=>[x.id,x]));const byPno=new Map(existingProcesses.filter(x=>x.number).map(x=>[norm(x.number),x]));const processMap=new Map();
    for(const raw of dataset.processes||[]){const incoming={...raw,clientId:clientIdMap.get(raw.clientId)||raw.clientId};const existing=byPid.get(incoming.id)||(incoming.number?byPno.get(norm(incoming.number)):null);if(!existing){await insertProcess(c,incoming);counts.processesCreated++;processMap.set(raw.id,incoming.id);byPid.set(incoming.id,incoming);if(incoming.number)byPno.set(norm(incoming.number),incoming);await sourceUpsert(c,spreadsheetId,incoming,'process');continue;}processMap.set(raw.id,existing.id);const next=mergeSheetRecord(existing,incoming);if(shouldUpdate(existing,next)&&isSheetOwned(existing,spreadsheetId)){await updateProcess(c,next);counts.processesUpdated++;await sourceUpsert(c,spreadsheetId,next,'process');}else{counts.skipped++;await sourceUpsert(c,spreadsheetId,{...incoming,id:existing.id},'process');}}
    const byTask=new Map((await readTasks(c)).map(x=>[x.id,x]));
    for(const raw of dataset.tasks||[]){const incoming={...raw,processId:raw.processId?(processMap.get(raw.processId)||raw.processId):null};const existing=byTask.get(incoming.id);if(!existing){await insertTask(c,incoming);counts.tasksCreated++;byTask.set(incoming.id,incoming);await sourceUpsert(c,spreadsheetId,incoming,'task');continue;}const next=mergeSheetRecord(existing,incoming);if(shouldUpdate(existing,next)&&isSheetOwned(existing,spreadsheetId)){await updateTask(c,next);counts.tasksUpdated++;await sourceUpsert(c,spreadsheetId,next,'task');}else{counts.skipped++;await sourceUpsert(c,spreadsheetId,incoming,'task');}}
    const byExec=new Map((await readExecutionActions(c)).map(x=>[x.id,x]));
    for(const raw of dataset.executions||[]){const incoming={...raw,processId:processMap.get(raw.processId)||raw.processId};const existing=byExec.get(incoming.id);if(!existing){await insertExecutionAction(c,incoming);counts.executionsCreated++;byExec.set(incoming.id,incoming);await sourceUpsert(c,spreadsheetId,incoming,'execution');continue;}const next=mergeSheetRecord(existing,incoming);if(shouldUpdate(existing,next)&&isSheetOwned(existing,spreadsheetId)){await updateExecutionAction(c,next);counts.executionsUpdated++;await sourceUpsert(c,spreadsheetId,next,'execution');}else{counts.skipped++;await sourceUpsert(c,spreadsheetId,incoming,'execution');}}
    if(apply&&auditRing){await appendAuditInTransaction(c,{id:`audit-${syncId}`,action:'CENTRAL_SHEET_SYNC_APPLIED',entity:'central_sheet',entityId:spreadsheetId,requestId,actor:actorId,detail:{mode,counts,warningsCount:(dataset.warnings||[]).length},at:new Date().toISOString()},auditRing);}
    const finishedAt=new Date().toISOString();
    if(apply){await c.query(`INSERT INTO central_juridica_sheet_sync_runs(sync_id,spreadsheet_id,spreadsheet_title,mode,status,started_at,finished_at,counts,warnings,actor_id,request_id) VALUES($1,$2,$3,$4,'success',$5::timestamptz,$6::timestamptz,$7::jsonb,$8::jsonb,$9,$10)`,[syncId,spreadsheetId,spreadsheetTitle,mode,startedAt,finishedAt,JSON.stringify(counts),JSON.stringify(dataset.warnings||[]),actorId,requestId]);await c.query('COMMIT');}else await c.query('ROLLBACK');
    return{ok:true,mode,applied:apply,counts,warnings:dataset.warnings||[],startedAt,finishedAt};
  }catch(e){try{await c.query('ROLLBACK')}catch{}throw e;}finally{c.release();}
}

async function sourceUpsert(q,spreadsheetId,record,entity){const src=record?.source?.centralSheet;if(!src?.sourceKey)return;await q.query(`INSERT INTO central_juridica_sheet_sources(spreadsheet_id,sheet_name,source_key,row_number,row_hash,domain_entity,domain_id,synced_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz) ON CONFLICT(spreadsheet_id,sheet_name,source_key) DO UPDATE SET row_number=excluded.row_number,row_hash=excluded.row_hash,domain_entity=excluded.domain_entity,domain_id=excluded.domain_id,synced_at=excluded.synced_at`,[spreadsheetId,src.sheetName,src.sourceKey,src.rowNumber,src.rowHash,entity,record.id,src.syncedAt]);}
function isSheetOwned(record,spreadsheetId){return record?.source?.centralSheet?.spreadsheetId===spreadsheetId;}
function mergeSheetRecord(existing,incoming){if(isSheetOwned(existing,incoming?.source?.centralSheet?.spreadsheetId)){const sameHash=existing?.source?.centralSheet?.rowHash&&existing.source.centralSheet.rowHash===incoming?.source?.centralSheet?.rowHash;return{...existing,...incoming,source:sameHash?existing.source:incoming.source,id:existing.id,createdAt:existing.createdAt||incoming.createdAt,updatedAt:sameHash?existing.updatedAt:new Date().toISOString()};}const next={...existing};for(const[k,v]of Object.entries(incoming)){if(k==='id'||k==='createdAt'||k==='source')continue;if((next[k]==null||next[k]==='')&&v!=null&&v!=='')next[k]=v;}next.source=existing.source||incoming.source;return next;}
function shouldUpdate(a,b){const strip=x=>{const y=structuredClone(x);delete y.updatedAt;return y;};return JSON.stringify(strip(a))!==JSON.stringify(strip(b));}
function norm(v){return String(v||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();}
