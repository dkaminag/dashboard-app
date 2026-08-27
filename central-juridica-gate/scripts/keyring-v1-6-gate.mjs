import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { parseKeyring } from '../src/keyring.mjs';
import { encryptLegacyDocument, encryptDocument, decryptDocument, documentKeyId } from '../src/crypto-storage-v1-6.mjs';
import { sealLegacy, sealMfa, openMfa } from '../src/mfa-v1-6.mjs';
import { makeLegacyState, migrateAudit, appendAudit, verifyAudit } from '../src/audit-integrity-v1-6.mjs';

if(!process.env.CJ_DATABASE_URL){console.error(JSON.stringify({ok:false,error:'CJ_DATABASE_URL ausente'}));process.exit(2);}
const enc=b=>b.toString('base64url');
const mkRing=(kind,oldKey,newKey)=>parseKeyring({value:JSON.stringify({activeKeyId:`${kind}-new`,legacyKeyId:`${kind}-old`,keys:{[`${kind}-old`]:enc(oldKey),[`${kind}-new`]:enc(newKey)}}),envName:`CJ_${kind.toUpperCase()}_KEYRING`,legacyEnvName:`CJ_${kind.toUpperCase()}_KEY`,production:true,devSeed:`${kind}-dev`,defaultKeyId:`${kind}-old`});
const missingOld=(kind,newKey)=>({activeKeyId:`${kind}-new`,legacyKeyId:`${kind}-old`,source:'gate-missing-old',keys:new Map([[`${kind}-new`,newKey]])});
const keys={auditOld:crypto.randomBytes(32),auditNew:crypto.randomBytes(32),docOld:crypto.randomBytes(32),docNew:crypto.randomBytes(32),mfaOld:crypto.randomBytes(32),mfaNew:crypto.randomBytes(32)};
const auditRing=mkRing('audit',keys.auditOld,keys.auditNew),docRing=mkRing('document',keys.docOld,keys.docNew),mfaRing=mkRing('mfa',keys.mfaOld,keys.mfaNew);
const pool=new pg.Pool({connectionString:process.env.CJ_DATABASE_URL,max:30,connectionTimeoutMillis:5000,idleTimeoutMillis:5000,statement_timeout:15000,application_name:'central-juridica-ci-keyring-v1-6'});
const runId=crypto.randomUUID();const evidence={runId,startedAt:new Date().toISOString(),phases:[]};const phase=(name,detail={})=>evidence.phases.push({name,ok:true,...detail});const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
  const version=(await pool.query('SELECT version() AS v')).rows[0].v;phase('postgres-connectivity',{version});
  await pool.query('CREATE TABLE IF NOT EXISTS central_juridica_keyring_gate_state(id integer PRIMARY KEY,state jsonb NOT NULL)');
  await pool.query('CREATE TABLE IF NOT EXISTS central_juridica_keyring_gate_docs(id text PRIMARY KEY,payload bytea NOT NULL)');
  await pool.query('DELETE FROM central_juridica_keyring_gate_state');await pool.query('DELETE FROM central_juridica_keyring_gate_docs');

  const t0='2026-08-27T18:00:00.000Z';
  const legacy=makeLegacyState([
    {id:'a2',action:'UPDATE',entity:'gate',entityId:'1',requestId:'r2',actor:{id:'gate',role:'admin'},detail:{value:'two'},at:'2026-08-27T18:01:00.000Z'},
    {id:'a1',action:'CREATE',entity:'gate',entityId:'1',requestId:'r1',actor:{id:'gate',role:'admin'},detail:{value:'one'},at:t0}
  ],keys.auditOld,{legacyKeyId:'audit-old'});
  assert.equal(legacy.auditLog.every(e=>e.chainVersion===1),true);
  await pool.query('INSERT INTO central_juridica_keyring_gate_state(id,state) VALUES(1,$1::jsonb)',[JSON.stringify(legacy)]);
  let state=(await pool.query('SELECT state FROM central_juridica_keyring_gate_state WHERE id=1')).rows[0].state;
  assert.equal(verifyAudit(state,auditRing).ok,true,'Cadeia v1.5 legítima deve verificar antes da migração.');
  const migration=migrateAudit(state,auditRing);assert.equal(migration.migrated,true);assert.equal(state.auditMeta.metaKeyId,'audit-new');assert.equal(state.auditLog.every(e=>e.chainVersion===1),true,'Migração não pode recalcular histórico.');
  const appended=appendAudit(state,{id:'a3',action:'ROTATED',entity:'gate',entityId:'1',requestId:'r3',actor:{id:'gate',role:'admin'},detail:{rotation:true},at:'2026-08-27T18:02:00.000Z'},auditRing);assert.equal(appended.keyId,'audit-new');assert.equal(verifyAudit(state,auditRing).ok,true);phase('audit-legacy-migration-and-new-key',{legacyEntries:2,newEntryKeyId:appended.keyId});
  await pool.query('UPDATE central_juridica_keyring_gate_state SET state=$1::jsonb WHERE id=1',[JSON.stringify(state)]);state=(await pool.query('SELECT state FROM central_juridica_keyring_gate_state WHERE id=1')).rows[0].state;assert.equal(state.version,9);assert.equal(verifyAudit(state,auditRing).ok,true);phase('state-v9-postgres-roundtrip');
  const noOldAudit=verifyAudit(state,missingOld('audit',keys.auditNew));assert.equal(noOldAudit.ok,false);assert.equal(noOldAudit.errors.some(e=>e.code==='KEY_NOT_FOUND'),true);phase('audit-historical-key-required',{errors:noOldAudit.errors.map(e=>e.code)});

  const oldPlain=Buffer.from('legacy-document-v1');const newPlain=Buffer.from('current-document-v2');const oldDoc=encryptLegacyDocument(oldPlain,keys.docOld),newDoc=encryptDocument(newPlain,docRing);assert.equal(documentKeyId(newDoc),'document-new');
  await pool.query('INSERT INTO central_juridica_keyring_gate_docs(id,payload) VALUES($1,$2),($3,$4)',['old',oldDoc,'new',newDoc]);const rows=await pool.query('SELECT id,payload FROM central_juridica_keyring_gate_docs ORDER BY id');const byId=new Map(rows.rows.map(r=>[r.id,Buffer.from(r.payload)]));assert.equal(decryptDocument(byId.get('old'),docRing).equals(oldPlain),true);assert.equal(decryptDocument(byId.get('new'),docRing).equals(newPlain),true);phase('document-rotation-compatible',{newKeyId:documentKeyId(byId.get('new'))});
  let docMissing=false;try{decryptDocument(byId.get('old'),missingOld('document',keys.docNew));}catch(e){docMissing=e.code==='KEY_NOT_FOUND';}assert.equal(docMissing,true);phase('document-historical-key-required');

  const oldMfa=sealLegacy('JBSWY3DPEHPK3PXP',keys.mfaOld);const newMfa=sealMfa('KRUGS4ZANFZSAYJA',mfaRing);assert.equal(newMfa.keyId,'mfa-new');assert.equal(openMfa(oldMfa,mfaRing),'JBSWY3DPEHPK3PXP');assert.equal(openMfa(newMfa,mfaRing),'KRUGS4ZANFZSAYJA');phase('mfa-rotation-compatible',{newKeyId:newMfa.keyId});
  let mfaMissing=false;try{openMfa(oldMfa,missingOld('mfa',keys.mfaNew));}catch(e){mfaMissing=e.code==='KEY_NOT_FOUND';}assert.equal(mfaMissing,true);phase('mfa-historical-key-required');

  await pool.query('UPDATE central_juridica_keyring_gate_state SET state=$1::jsonb WHERE id=1',[JSON.stringify({version:9,clients:[],auditMeta:{},auditLog:[]})]);
  const writers=Array.from({length:25},(_,i)=>(async()=>{const c=await pool.connect();try{await c.query('BEGIN');const q=await c.query('SELECT state FROM central_juridica_keyring_gate_state WHERE id=1 FOR UPDATE');const s=q.rows[0].state;await sleep(5+((i*7)%25));s.clients=Array.isArray(s.clients)?s.clients:[];s.clients.push({id:`c${i}`,name:`Gate ${i}`});await c.query('UPDATE central_juridica_keyring_gate_state SET state=$1::jsonb WHERE id=1',[JSON.stringify(s)]);await c.query('COMMIT');}catch(e){try{await c.query('ROLLBACK');}catch{}throw e;}finally{c.release();}})());
  await Promise.all(writers);const final=(await pool.query('SELECT state FROM central_juridica_keyring_gate_state WHERE id=1')).rows[0].state;assert.equal(final.version,9);assert.equal(final.clients.length,25);assert.equal(new Set(final.clients.map(c=>c.id)).size,25);phase('state-v9-concurrency',{writers:25,persisted:25,lostUpdates:0});

  evidence.finishedAt=new Date().toISOString();evidence.summary={stateVersion:9,auditLegacyMigration:true,auditNewKeyId:true,auditHistoricalKeyRequired:true,documentLegacyReadAfterRotation:true,documentNewKeyId:true,documentHistoricalKeyRequired:true,mfaLegacyReadAfterRotation:true,mfaNewKeyId:true,mfaHistoricalKeyRequired:true,writers:25,persisted:25,lostUpdates:0};console.log(JSON.stringify({ok:true,evidence},null,2));
}catch(error){evidence.finishedAt=new Date().toISOString();console.error(JSON.stringify({ok:false,evidence,error:{name:error.name,message:error.message,code:error.code||null,stack:error.stack}},null,2));process.exitCode=1;}finally{try{await pool.query('DROP TABLE IF EXISTS central_juridica_keyring_gate_docs');await pool.query('DROP TABLE IF EXISTS central_juridica_keyring_gate_state');}catch{}await pool.end();}
