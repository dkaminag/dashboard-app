import crypto from 'node:crypto';

const CHAIN_VERSION = 1;
const META_VERSION = 1;
const MAX_AUDIT_ENTRIES = 5000;

export function loadAuditKey(value = process.env.CJ_AUDIT_KEY) {
  if (!value) throw new Error('CJ_AUDIT_KEY ausente.');
  const key = Buffer.from(String(value), 'base64url');
  if (key.length !== 32) throw new Error('CJ_AUDIT_KEY inválida.');
  return key;
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function entryPayload(entry) {
  return { chainVersion: CHAIN_VERSION, id: entry.id, action: entry.action, entity: entry.entity, entityId: entry.entityId ?? null, requestId: entry.requestId ?? null, actor: entry.actor ?? null, detail: entry.detail ?? {}, at: entry.at, prevHash: entry.prevHash ?? null, baseline: Boolean(entry.baseline) };
}
function metaPayload(meta = {}) {
  return { metaVersion: META_VERSION, initialized: Boolean(meta.initialized), chainVersion: Number(meta.chainVersion || CHAIN_VERSION), initializedAt: meta.initializedAt || null, baselineCount: Number(meta.baselineCount || 0), headHash: meta.headHash || null, tailHash: meta.tailHash || null, retainedCount: Number(meta.retainedCount || 0), totalAppended: Number(meta.totalAppended || 0), droppedCount: Number(meta.droppedCount || 0), lastAppendedAt: meta.lastAppendedAt || null, metadataSealedAt: meta.metadataSealedAt || null };
}
export const computeAuditHash = (entry,key) => crypto.createHmac('sha256',key).update(canonical(entryPayload(entry)),'utf8').digest('hex');
export const computeAuditMetaMac = (meta,key) => crypto.createHmac('sha256',key).update(canonical(metaPayload(meta)),'utf8').digest('hex');

function refreshMeta(state,key,patch={}) {
  const log=state.auditLog||[]; const prior=state.auditMeta||{}; const total=Math.max(log.length,Number(patch.totalAppended ?? prior.totalAppended ?? log.length));
  const meta={...prior,...patch,initialized:true,chainVersion:CHAIN_VERSION,metaVersion:META_VERSION,initializedAt:patch.initializedAt??prior.initializedAt??new Date().toISOString(),baselineCount:Number(patch.baselineCount??prior.baselineCount??log.length),headHash:log[0]?.hash||null,tailHash:log.at(-1)?.prevHash||null,retainedCount:log.length,totalAppended:total,droppedCount:Math.max(0,total-log.length),lastAppendedAt:patch.lastAppendedAt??prior.lastAppendedAt??null,metadataSealedAt:patch.metadataSealedAt??prior.metadataSealedAt??new Date().toISOString()};
  meta.metaMac=computeAuditMetaMac(meta,key); state.auditMeta=meta; return meta;
}

export function initializeAuditChain(state,key,now=new Date().toISOString()) {
  const log=state.auditLog||[];
  if(state.auditMeta?.initialized && log.every(e=>e.chainVersion===CHAIN_VERSION && typeof e.hash==='string')) { if(!state.auditMeta.metaMac) refreshMeta(state,key,{metadataSealedAt:now}); return; }
  let prevHash=null; const rebuilt=[];
  for(const original of log.slice().reverse()) { const entry={...original,chainVersion:CHAIN_VERSION,prevHash,baseline:true}; delete entry.hash; entry.hash=computeAuditHash(entry,key); prevHash=entry.hash; rebuilt.push(entry); }
  state.auditLog=rebuilt.reverse().slice(0,MAX_AUDIT_ENTRIES); state.auditMeta={initialized:true,chainVersion:CHAIN_VERSION,metaVersion:META_VERSION,initializedAt:now,baselineCount:state.auditLog.length,totalAppended:state.auditLog.length,droppedCount:0,lastAppendedAt:null,metadataSealedAt:now}; refreshMeta(state,key,{initializedAt:now,baselineCount:state.auditLog.length,totalAppended:state.auditLog.length,metadataSealedAt:now});
}

export function appendAuditEntry(state,fields,key) {
  initializeAuditChain(state,key); const priorTotal=Number(state.auditMeta.totalAppended??state.auditLog.length); const entry={...fields,chainVersion:CHAIN_VERSION,prevHash:state.auditLog[0]?.hash||state.auditMeta.tailHash||null,baseline:false}; entry.hash=computeAuditHash(entry,key); state.auditLog.unshift(entry); state.auditLog=state.auditLog.slice(0,MAX_AUDIT_ENTRIES); refreshMeta(state,key,{totalAppended:priorTotal+1,lastAppendedAt:entry.at}); return entry;
}

function safeEqual(actual,expected){ if(typeof actual!=='string'||!/^[a-f0-9]{64}$/i.test(actual))return false; try{return crypto.timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));}catch{return false;} }
export function verifyAuditChain(state,key) {
  const errors=[]; const log=state.auditLog||[]; const meta=state.auditMeta||{}; const total=Number(meta.totalAppended??log.length); const dropped=Number(meta.droppedCount??Math.max(0,total-log.length));
  if(!meta.initialized)errors.push('META_NOT_INITIALIZED'); if(meta.retainedCount!==log.length)errors.push('COUNT_MISMATCH'); if(meta.metaVersion!==META_VERSION)errors.push('META_VERSION_MISMATCH'); if(dropped!==Math.max(0,total-log.length))errors.push('DROPPED_COUNT_MISMATCH');
  if(!meta.metaMac)errors.push('META_MAC_MISSING'); else if(!safeEqual(meta.metaMac,computeAuditMetaMac(meta,key)))errors.push('META_MAC_MISMATCH');
  for(let i=0;i<log.length;i++){const entry=log[i];const expectedPrev=i+1<log.length?log[i+1].hash:meta.tailHash||null;if((entry.prevHash||null)!==expectedPrev)errors.push(`PREV_HASH_MISMATCH:${i}`);if(!safeEqual(entry.hash,computeAuditHash(entry,key)))errors.push(`HASH_MISMATCH:${i}`);}
  if((meta.headHash||null)!==(log[0]?.hash||null))errors.push('HEAD_HASH_MISMATCH'); return {ok:errors.length===0,errors,retainedCount:log.length,totalAppended:total,droppedCount:dropped};
}
