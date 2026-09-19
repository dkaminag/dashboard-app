import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { activeKey, makeSingleKeyring, parseKeyring, resolveKey } from './keyring.mjs';

const BACKUP_VERSION_CURRENT = 3;
const BACKUP_VERSION_LEGACY = 2;
const DEV_BACKUP_KEY = crypto.createHash('sha256').update('central-juridica-development-backup-key-v2').digest();

export function loadBackupKey(value = process.env.CJ_BACKUP_KEY, { production = process.env.CJ_ENV === 'production' } = {}) {
  if (!value) { if (production) throw new Error('Modo production exige CJ_BACKUP_KEY para backup criptografado.'); return DEV_BACKUP_KEY; }
  let key; try { key = Buffer.from(String(value), 'base64url'); } catch { key = null; }
  if (!key || key.length !== 32) throw new Error('CJ_BACKUP_KEY deve ser uma chave base64url de exatamente 32 bytes.');
  return key;
}

export function loadBackupKeyring({ value = process.env.CJ_BACKUP_KEYRING, legacyValue = process.env.CJ_BACKUP_KEY, production = process.env.CJ_ENV === 'production' } = {}) {
  return parseKeyring({ value, legacyValue, envName: 'CJ_BACKUP_KEYRING', legacyEnvName: 'CJ_BACKUP_KEY', production, devSeed: 'central-juridica-development-backup-key-v2', defaultKeyId: 'backup-legacy-v2' });
}

function asRing(keyOrRing) { return Buffer.isBuffer(keyOrRing) ? makeSingleKeyring(keyOrRing, { keyId: 'backup-legacy-v2', source: 'compat-buffer' }) : keyOrRing; }
function canonical(value) { if (value === null || typeof value !== 'object') return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; const keys=Object.keys(value).sort(); return `{${keys.map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`; }
function safeHexEqual(actual,expected){if(typeof actual!=='string'||!/^[a-f0-9]{64}$/i.test(actual))return false;try{return crypto.timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));}catch{return false;}}
function sha256(bytes){return crypto.createHash('sha256').update(bytes).digest('hex');}
function derive(rootKey,salt,info){return Buffer.from(crypto.hkdfSync('sha256',rootKey,salt,Buffer.from(info),32));}
function encryptBytes(bytes,key,aad){const iv=crypto.randomBytes(12);const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(aad));const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);return{algorithm:'AES-256-GCM',iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),ciphertext:ciphertext.toString('base64')};}
function decryptBytes(envelope,key,aad){if(!envelope||envelope.algorithm!=='AES-256-GCM')throw new Error('Envelope de backup inválido.');const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64url'));decipher.setAAD(Buffer.from(aad));decipher.setAuthTag(Buffer.from(envelope.tag,'base64url'));return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]);}
async function writeJson(filePath,value){const bytes=Buffer.from(JSON.stringify(value),'utf8');await fs.writeFile(filePath,bytes,{mode:0o600});return{bytes,sha256:sha256(bytes),size:bytes.length};}

async function collectSnapshot({store,documentDir,backend}){
  if(backend==='postgres'&&typeof store.exportSnapshot==='function')return store.exportSnapshot();
  const state=await store.read();const documents=[];
  for(const document of state.documents||[]){if(!document.storageName)continue;const payload=await fs.readFile(path.join(documentDir,document.storageName));documents.push({documentId:document.id,storageName:document.storageName,payload,storedSha256:sha256(payload)});}
  return{state,documents};
}
function manifestPayload(manifest){const{manifestMac,...payload}=manifest;return payload;}
function computeManifestMac(manifest,key){const prefix=manifest.version===BACKUP_VERSION_LEGACY?'backup-manifest-v2\0':'backup-manifest-v3\0';return crypto.createHmac('sha256',key).update(prefix).update(canonical(manifestPayload(manifest)),'utf8').digest('hex');}

export async function createBackup({store,documentDir,backupRoot,backend='json',backupKeyring=loadBackupKeyring(),backupKey}={}){
  if(!store||!documentDir||!backupRoot)throw new TypeError('Parâmetros de backup incompletos.');
  const ring=backupKey?asRing(backupKey):asRing(backupKeyring);const rootKey=activeKey(ring);const keyId=ring.activeKeyId;
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');const target=path.join(backupRoot,`central-juridica-${stamp}`);const docsTarget=path.join(target,'documents');await fs.mkdir(docsTarget,{recursive:true,mode:0o700});
  const snapshot=await collectSnapshot({store,documentDir,backend});const salt=crypto.randomBytes(32);const statePlain=Buffer.from(JSON.stringify(snapshot.state),'utf8');
  const stateEnvelope=encryptBytes(statePlain,derive(rootKey,salt,'central-juridica-backup-state-v2'),'central-juridica-backup-v2|state');const stateFile=await writeJson(path.join(target,'state.enc.json'),stateEnvelope);
  const documents=[];
  for(let i=0;i<snapshot.documents.length;i+=1){const document=snapshot.documents[i];const documentId=String(document.documentId||`document-${i}`);const plainSha256=sha256(document.payload);if(String(document.storedSha256||plainSha256).trim()!==plainSha256)throw new Error(`Hash do blob de origem divergente: ${documentId}`);const fileName=`${String(i+1).padStart(4,'0')}-${sha256(Buffer.from(documentId)).slice(0,16)}.enc.json`;const aad=`central-juridica-backup-v2|document|${documentId}`;const envelope=encryptBytes(document.payload,derive(rootKey,salt,`central-juridica-backup-document-v2|${documentId}`),aad);const file=await writeJson(path.join(docsTarget,fileName),envelope);documents.push({documentId,storageName:document.storageName||null,path:`documents/${fileName}`,cipherSha256:file.sha256,cipherSize:file.size,storedSha256:plainSha256});}
  const manifest={version:BACKUP_VERSION_CURRENT,createdAt:new Date().toISOString(),backend,crypto:{encryption:'AES-256-GCM',kdf:'HKDF-SHA-256',salt:salt.toString('base64url'),keyId},state:{path:'state.enc.json',cipherSha256:stateFile.sha256,cipherSize:stateFile.size,plainSha256:sha256(statePlain),stateVersion:snapshot.state.version},documents};
  manifest.manifestMac=computeManifestMac(manifest,derive(rootKey,salt,'central-juridica-backup-manifest-v2'));await fs.writeFile(path.join(target,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});return{target,manifest};
}

async function openVerifiedBackup(target,ring){
  const manifest=JSON.parse(await fs.readFile(path.join(target,'manifest.json'),'utf8'));const errors=[];
  if(![BACKUP_VERSION_LEGACY,BACKUP_VERSION_CURRENT].includes(manifest.version))errors.push('MANIFEST_VERSION_UNSUPPORTED');let salt=null;try{salt=Buffer.from(manifest.crypto?.salt||'','base64url');}catch{}if(!salt||salt.length!==32)errors.push('SALT_INVALID');
  let rootKey=null;let keyId=null;
  if(salt){try{keyId=manifest.version===BACKUP_VERSION_CURRENT?manifest.crypto?.keyId:null;rootKey=resolveKey(ring,keyId,{allowLegacyFallback:manifest.version===BACKUP_VERSION_LEGACY}).key;}catch(error){errors.push(`BACKUP_KEY_NOT_FOUND:${error.keyId||keyId||'legacy'}`);}}
  if(rootKey&&salt){const expected=computeManifestMac(manifest,derive(rootKey,salt,'central-juridica-backup-manifest-v2'));if(!safeHexEqual(manifest.manifestMac,expected))errors.push('MANIFEST_MAC_MISMATCH');}
  if(errors.length)return{ok:false,errors,manifest,snapshot:null};
  let state=null;
  try{const stateBytes=await fs.readFile(path.join(target,manifest.state.path));if(sha256(stateBytes)!==manifest.state.cipherSha256)errors.push('STATE_CIPHER_HASH_MISMATCH');try{const plain=decryptBytes(JSON.parse(stateBytes.toString()),derive(rootKey,salt,'central-juridica-backup-state-v2'),'central-juridica-backup-v2|state');if(sha256(plain)!==manifest.state.plainSha256)errors.push('STATE_PLAIN_HASH_MISMATCH');state=JSON.parse(plain.toString());}catch{errors.push('STATE_DECRYPT_FAILED');}}catch{errors.push('STATE_FILE_MISSING');}
  const documents=[];for(const item of manifest.documents||[]){try{const cipherBytes=await fs.readFile(path.join(target,item.path));if(sha256(cipherBytes)!==item.cipherSha256){errors.push(`DOCUMENT_CIPHER_HASH_MISMATCH:${item.documentId}`);continue;}try{const payload=decryptBytes(JSON.parse(cipherBytes.toString()),derive(rootKey,salt,`central-juridica-backup-document-v2|${item.documentId}`),`central-juridica-backup-v2|document|${item.documentId}`);const actual=sha256(payload);if(actual!==item.storedSha256){errors.push(`DOCUMENT_PLAIN_HASH_MISMATCH:${item.documentId}`);continue;}documents.push({documentId:item.documentId,storageName:item.storageName||null,payload,storedSha256:actual});}catch{errors.push(`DOCUMENT_DECRYPT_FAILED:${item.documentId}`);}}catch{errors.push(`DOCUMENT_FILE_MISSING:${item.documentId}`);}}
  return{ok:errors.length===0,errors,manifest,snapshot:state?{state,documents}:null};
}

export async function verifyBackup(target,{backupKeyring=loadBackupKeyring(),backupKey}={}){const ring=backupKey?asRing(backupKey):asRing(backupKeyring);const r=await openVerifiedBackup(target,ring);return{ok:r.ok,errors:r.errors,manifest:r.manifest,results:[{path:r.manifest?.state?.path||'state.enc.json',ok:!r.errors.some(e=>String(e).startsWith('STATE_'))},...(r.manifest?.documents||[]).map(item=>({path:item.path,ok:!r.errors.some(e=>String(e).includes(item.documentId))}))]};}
export async function restoreBackup({store,documentDir,target,backend='json',backupKeyring=loadBackupKeyring(),backupKey}){if(!store||!documentDir||!target)throw new TypeError('Parâmetros de restore incompletos.');const ring=backupKey?asRing(backupKey):asRing(backupKeyring);const opened=await openVerifiedBackup(target,ring);if(!opened.ok||!opened.snapshot)throw Object.assign(new Error('Backup reprovado na verificação de integridade.'),{verify:{ok:opened.ok,errors:opened.errors,manifest:opened.manifest}});if(backend==='postgres'&&typeof store.restoreSnapshot==='function')return store.restoreSnapshot(opened.snapshot);await fs.mkdir(documentDir,{recursive:true,mode:0o700});const staged=[];try{for(const document of opened.snapshot.documents){const storageName=document.storageName||opened.snapshot.state.documents?.find(d=>d.id===document.documentId)?.storageName;if(!storageName)throw new Error(`storageName ausente no restore local: ${document.documentId}`);const dst=path.join(documentDir,storageName),tmp=`${dst}.restore-tmp`;await fs.writeFile(tmp,document.payload,{mode:0o600});if(sha256(await fs.readFile(tmp))!==document.storedSha256)throw new Error(`Hash divergente durante restore: ${storageName}`);staged.push({tmp,dst});}for(const item of staged)await fs.rename(item.tmp,item.dst);await store.replaceState(opened.snapshot.state);return{ok:true,restoredDocuments:staged.length,restoredVersion:opened.snapshot.state.version};}catch(error){for(const item of staged){try{await fs.rm(item.tmp,{force:true});}catch{}}throw error;}}
