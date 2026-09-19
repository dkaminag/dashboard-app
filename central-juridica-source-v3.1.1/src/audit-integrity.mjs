import crypto from 'node:crypto';
import { activeKey, makeSingleKeyring, parseKeyring, resolveKey } from './keyring.mjs';

const ENTRY_VERSION_LEGACY = 1;
const ENTRY_VERSION_CURRENT = 2;
const META_VERSION_LEGACY = 2;
const META_VERSION_CURRENT = 3;
const MAX_AUDIT_ENTRIES = 5000;
const DEV_AUDIT_KEY = crypto.createHash('sha256').update('central-juridica-development-audit-integrity-key-v1').digest();

export function loadAuditKey(value = process.env.CJ_AUDIT_KEY, { production = process.env.CJ_ENV === 'production' } = {}) {
  if (!value) {
    if (production) throw new Error('Modo production exige CJ_AUDIT_KEY para integridade da trilha de auditoria.');
    return DEV_AUDIT_KEY;
  }
  let key; try { key = Buffer.from(String(value), 'base64url'); } catch { key = null; }
  if (!key || key.length !== 32) throw new Error('CJ_AUDIT_KEY deve ser uma chave base64url de exatamente 32 bytes.');
  return key;
}

export function loadAuditKeyring({ value = process.env.CJ_AUDIT_KEYRING, legacyValue = process.env.CJ_AUDIT_KEY, production = process.env.CJ_ENV === 'production' } = {}) {
  return parseKeyring({ value, legacyValue, envName: 'CJ_AUDIT_KEYRING', legacyEnvName: 'CJ_AUDIT_KEY', production, devSeed: 'central-juridica-development-audit-integrity-key-v1', defaultKeyId: 'audit-legacy-v1' });
}

function asRing(keyOrRing) { return Buffer.isBuffer(keyOrRing) ? makeSingleKeyring(keyOrRing, { keyId: 'audit-legacy-v1', source: 'compat-buffer' }) : keyOrRing; }
function canonical(value) { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; const keys = Object.keys(value).sort(); return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`; }
function safeHexEqual(actual, expected) { if (typeof actual !== 'string' || !/^[a-f0-9]{64}$/i.test(actual)) return false; try { return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex')); } catch { return false; } }

function entryPayloadV1(entry) {
  return { chainVersion: ENTRY_VERSION_LEGACY, id: entry.id, action: entry.action, entity: entry.entity, entityId: entry.entityId ?? null, requestId: entry.requestId ?? null, actor: entry.actor ?? null, detail: entry.detail ?? {}, at: entry.at, prevHash: entry.prevHash ?? null, baseline: Boolean(entry.baseline) };
}
function entryPayloadV2(entry) {
  return { chainVersion: ENTRY_VERSION_CURRENT, keyId: entry.keyId, id: entry.id, action: entry.action, entity: entry.entity, entityId: entry.entityId ?? null, requestId: entry.requestId ?? null, actor: entry.actor ?? null, detail: entry.detail ?? {}, at: entry.at, prevHash: entry.prevHash ?? null, baseline: Boolean(entry.baseline) };
}
function legacyMetaPayload(meta={}) {
  return { metaVersion: META_VERSION_LEGACY, chainVersion: ENTRY_VERSION_LEGACY, initialized: Boolean(meta.initialized), initializedAt: meta.initializedAt || null, baselineCount: Number(meta.baselineCount || 0), headHash: meta.headHash || null, tailHash: meta.tailHash || null, retainedCount: Number(meta.retainedCount || 0), droppedCount: Number(meta.droppedCount || 0), lastAppendedAt: meta.lastAppendedAt || null };
}
function metaPayload(meta={}) {
  return { metaVersion: META_VERSION_CURRENT, latestEntryVersion: ENTRY_VERSION_CURRENT, initialized: Boolean(meta.initialized), initializedAt: meta.initializedAt || null, baselineCount: Number(meta.baselineCount || 0), headHash: meta.headHash || null, tailHash: meta.tailHash || null, retainedCount: Number(meta.retainedCount || 0), droppedCount: Number(meta.droppedCount || 0), lastAppendedAt: meta.lastAppendedAt || null, legacyKeyId: meta.legacyKeyId || null, metaKeyId: meta.metaKeyId || null };
}

export function computeAuditHash(entry, keyOrRing) {
  const ring = asRing(keyOrRing); const version = Number(entry.chainVersion || ENTRY_VERSION_LEGACY);
  let resolved;
  if (version === ENTRY_VERSION_LEGACY) resolved = resolveKey(ring, null, { allowLegacyFallback: true });
  else if (version === ENTRY_VERSION_CURRENT) resolved = resolveKey(ring, entry.keyId);
  else throw new Error(`Versão de entrada de auditoria não suportada: ${version}`);
  const prefix = version === ENTRY_VERSION_LEGACY ? 'entry-v1\0' : 'entry-v2\0';
  const payload = version === ENTRY_VERSION_LEGACY ? entryPayloadV1(entry) : entryPayloadV2(entry);
  return crypto.createHmac('sha256', resolved.key).update(prefix).update(canonical(payload), 'utf8').digest('hex');
}

function computeLegacyMetaMac(meta, key) { return crypto.createHmac('sha256', key).update('meta-v2\0').update(canonical(legacyMetaPayload(meta)), 'utf8').digest('hex'); }
export function computeAuditMetaMac(meta, keyOrRing) {
  const ring = asRing(keyOrRing); const keyId = meta.metaKeyId || ring.activeKeyId; const { key } = resolveKey(ring, keyId);
  return crypto.createHmac('sha256', key).update('meta-v3\0').update(canonical(metaPayload(meta)), 'utf8').digest('hex');
}
function sealMeta(state, ring) { state.auditMeta.metaVersion=META_VERSION_CURRENT; state.auditMeta.metaKeyId=ring.activeKeyId; state.auditMeta.metaMac=computeAuditMetaMac(state.auditMeta,ring); }

function verifyEntriesAndLinks(log, meta, ring, errors) {
  for (let i=0;i<log.length;i+=1) {
    const entry=log[i]; const expectedPrev=i+1<log.length ? log[i+1]?.hash||null : meta.tailHash||null;
    if ((entry.prevHash||null)!==expectedPrev) errors.push({code:'PREV_HASH_MISMATCH',index:i,id:entry.id});
    try { const expected=computeAuditHash(entry,ring); if(!safeHexEqual(entry.hash,expected)) errors.push({code:'HASH_MISMATCH',index:i,id:entry.id}); }
    catch(error){ errors.push({code:'KEY_NOT_FOUND',index:i,id:entry.id,keyId:error.keyId||entry.keyId||meta.legacyKeyId||ring.legacyKeyId}); }
  }
}

function verifyLegacyV15(state, ring) {
  const log=Array.isArray(state.auditLog)?state.auditLog:[]; const meta=state.auditMeta||{}; const errors=[];
  let legacy;
  try { legacy=resolveKey(ring,meta.legacyKeyId||ring.legacyKeyId,{allowLegacyFallback:true}); } catch(error){ return {ok:false,errors:[{code:'KEY_NOT_FOUND',keyId:error.keyId}]}; }
  if ((meta.retainedCount??-1)!==log.length) errors.push({code:'COUNT_MISMATCH'});
  if (meta.metaVersion===META_VERSION_LEGACY && meta.metaMac) {
    const expected=computeLegacyMetaMac(meta,legacy.key); if(!safeHexEqual(meta.metaMac,expected)) errors.push({code:'META_MAC_MISMATCH'});
  }
  for(let i=0;i<log.length;i+=1){ const e=log[i]; const expectedPrev=i+1<log.length?log[i+1]?.hash||null:meta.tailHash||null; if((e.prevHash||null)!==expectedPrev)errors.push({code:'PREV_HASH_MISMATCH',index:i}); const expected=crypto.createHmac('sha256',legacy.key).update('entry-v1\0').update(canonical(entryPayloadV1({...e,chainVersion:1})),'utf8').digest('hex'); if(!safeHexEqual(e.hash,expected))errors.push({code:'HASH_MISMATCH',index:i}); }
  if((meta.headHash||null)!==(log[0]?.hash||null))errors.push({code:'HEAD_HASH_MISMATCH'});
  return {ok:errors.length===0,errors};
}

export function initializeAuditChain(state, keyOrRing, now=new Date().toISOString()) {
  const ring=asRing(keyOrRing); const log=Array.isArray(state.auditLog)?state.auditLog:[]; const meta=state.auditMeta||{};
  const sealed=meta.initialized && log.every(e=>typeof e?.hash==='string' && [1,2].includes(Number(e.chainVersion||1)));
  if (sealed && meta.metaVersion===META_VERSION_CURRENT) {
    const verified=verifyAuditChain(state,ring); if(!verified.ok) throw Object.assign(new Error('Trilha de auditoria existente reprovada; rotação/migração bloqueada.'),{verification:verified});
    if(meta.metaKeyId!==ring.activeKeyId){ state.auditMeta.metaKeyId=ring.activeKeyId; sealMeta(state,ring); return {initialized:false,metadataUpgraded:false,metadataRotated:true,baselineCount:meta.baselineCount||0}; }
    return {initialized:false,metadataUpgraded:false,metadataRotated:false,baselineCount:meta.baselineCount||0};
  }
  if (sealed) {
    const legacy=verifyLegacyV15(state,ring); if(!legacy.ok) throw Object.assign(new Error('Trilha legada existente reprovada; migração de keyring bloqueada.'),{verification:legacy});
    const oldest=log.at(-1)||null;
    state.auditMeta={...meta,initialized:true,metaVersion:META_VERSION_CURRENT,latestEntryVersion:ENTRY_VERSION_CURRENT,legacyKeyId:ring.legacyKeyId,metaKeyId:ring.activeKeyId,headHash:log[0]?.hash||null,tailHash:meta.tailHash??oldest?.prevHash??null,retainedCount:log.length,droppedCount:Number(meta.droppedCount||0),lastAppendedAt:meta.lastAppendedAt||null};
    sealMeta(state,ring); return {initialized:false,metadataUpgraded:true,metadataRotated:ring.activeKeyId!==ring.legacyKeyId,baselineCount:meta.baselineCount||0};
  }

  let prevHash=null; const rebuilt=[];
  for(const original of log.slice().reverse()){
    const entry={id:original.id,action:original.action,entity:original.entity,entityId:original.entityId??null,requestId:original.requestId??null,actor:original.actor??null,detail:original.detail??{},at:original.at,chainVersion:ENTRY_VERSION_CURRENT,keyId:ring.activeKeyId,prevHash,baseline:true};
    entry.hash=computeAuditHash(entry,ring); prevHash=entry.hash; rebuilt.push(entry);
  }
  const fullCount=rebuilt.length; state.auditLog=rebuilt.reverse().slice(0,MAX_AUDIT_ENTRIES); const oldest=state.auditLog.at(-1)||null;
  state.auditMeta={initialized:true,metaVersion:META_VERSION_CURRENT,latestEntryVersion:ENTRY_VERSION_CURRENT,initializedAt:now,baselineCount:state.auditLog.length,baselineMeaning:'Entradas existentes foram seladas como baseline; a cadeia comprova integridade posterior, não autenticidade histórica anterior ao baseline.',headHash:state.auditLog[0]?.hash||null,tailHash:oldest?.prevHash||null,retainedCount:state.auditLog.length,droppedCount:Math.max(0,fullCount-state.auditLog.length),lastAppendedAt:null,legacyKeyId:ring.legacyKeyId,metaKeyId:ring.activeKeyId};
  sealMeta(state,ring); return {initialized:true,metadataUpgraded:false,metadataRotated:false,baselineCount:state.auditLog.length};
}

export function appendAuditEntry(state, fields, keyOrRing) {
  const ring=asRing(keyOrRing); if(!state.auditMeta?.initialized || state.auditMeta.metaVersion!==META_VERSION_CURRENT) initializeAuditChain(state,ring);
  else { const verified=verifyAuditChain(state,ring); if(!verified.ok) throw Object.assign(new Error('Trilha de auditoria inválida; append bloqueado.'),{verification:verified}); if(state.auditMeta.metaKeyId!==ring.activeKeyId){state.auditMeta.metaKeyId=ring.activeKeyId;sealMeta(state,ring);} }
  const entry={...fields,chainVersion:ENTRY_VERSION_CURRENT,keyId:ring.activeKeyId,prevHash:state.auditLog[0]?.hash||state.auditMeta?.tailHash||null,baseline:false}; entry.hash=computeAuditHash(entry,ring); state.auditLog.unshift(entry);
  const overflow=Math.max(0,state.auditLog.length-MAX_AUDIT_ENTRIES); if(overflow)state.auditLog=state.auditLog.slice(0,MAX_AUDIT_ENTRIES); const oldest=state.auditLog.at(-1)||null;
  state.auditMeta={...state.auditMeta,metaVersion:META_VERSION_CURRENT,latestEntryVersion:ENTRY_VERSION_CURRENT,headHash:state.auditLog[0]?.hash||null,tailHash:oldest?.prevHash||null,retainedCount:state.auditLog.length,droppedCount:Number(state.auditMeta?.droppedCount||0)+overflow,lastAppendedAt:entry.at,legacyKeyId:state.auditMeta.legacyKeyId||ring.legacyKeyId,metaKeyId:ring.activeKeyId}; sealMeta(state,ring); return entry;
}

export function verifyAuditChain(state, keyOrRing) {
  const ring=asRing(keyOrRing); const log=Array.isArray(state.auditLog)?state.auditLog:[]; const meta=state.auditMeta||{};
  if(meta.metaVersion===META_VERSION_LEGACY) return {...verifyLegacyV15(state,ring),algorithm:'HMAC-SHA-256',metaVersion:META_VERSION_LEGACY,retainedCount:log.length};
  const errors=[]; if(!meta.initialized)errors.push({code:'META_NOT_INITIALIZED'}); if(meta.metaVersion!==META_VERSION_CURRENT)errors.push({code:'META_VERSION_MISMATCH',expected:META_VERSION_CURRENT,actual:meta.metaVersion??null}); if((meta.retainedCount??-1)!==log.length)errors.push({code:'COUNT_MISMATCH',expected:meta.retainedCount,actual:log.length});
  try{ const expected=computeAuditMetaMac(meta,ring); if(!safeHexEqual(meta.metaMac,expected))errors.push({code:'META_MAC_MISMATCH'});}catch(error){errors.push({code:'META_KEY_NOT_FOUND',keyId:error.keyId||meta.metaKeyId});}
  verifyEntriesAndLinks(log,meta,ring,errors); const actualHead=log[0]?.hash||null; if((meta.headHash||null)!==actualHead)errors.push({code:'HEAD_HASH_MISMATCH'});
  return {ok:errors.length===0,algorithm:'HMAC-SHA-256',entryVersionCurrent:ENTRY_VERSION_CURRENT,metaVersion:META_VERSION_CURRENT,retainedCount:log.length,droppedCount:Number(meta.droppedCount||0),baselineCount:Number(meta.baselineCount||0),initializedAt:meta.initializedAt||null,headHash:actualHead,activeKeyId:ring.activeKeyId,metaKeyId:meta.metaKeyId||null,legacyKeyId:meta.legacyKeyId||null,errors};
}
