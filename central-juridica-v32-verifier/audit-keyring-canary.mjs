import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const RELEASE = 'd507a9955be07ef710d410b5263686ac75caeeff';
const HISTORICAL_ID = String(process.env.CJ_AUDIT_LEGACY_KEY_ID || '').trim();
if (HISTORICAL_ID !== 'audit-2026-09-prod') throw new Error('AUDIT_LEGACY_KEY_ID_NOT_PINNED');
if (!process.env.CJ_AUDIT_KEY || !process.env.CJ_AUDIT_KEYRING || !process.env.CJ_DATABASE_URL) {
  throw new Error('AUDIT_KEYRING_CANARY_CONFIG_MISSING');
}

function exec(cmd,args,cwd,env=process.env){
  return new Promise((resolve,reject)=>{
    const child=spawn(cmd,args,{cwd,env,stdio:'inherit'});
    child.once('error',reject);
    child.once('exit',code=>code===0?resolve():reject(new Error(cmd+'_FAILED_'+code)));
  });
}

const root=await fs.mkdtemp(path.join(os.tmpdir(),'cj-audit-key-canary-'));
const archive=path.join(root,'source.tgz');
const response=await fetch('https://codeload.github.com/dkaminag/dashboard-app/tar.gz/'+RELEASE);
if(!response.ok) throw new Error('RELEASE_FETCH_'+response.status);
await fs.writeFile(archive,Buffer.from(await response.arrayBuffer()));
const src=path.join(root,'src');
await fs.mkdir(src);
await exec('tar',['-xzf',archive,'-C',src,'--strip-components=1'],root);

const candidate=path.join(src,'central-juridica-railway-v3.2.0');
await exec(process.execPath,['unpack.mjs'],candidate);
await exec(process.execPath,['apply-overlay.mjs'],candidate);
await exec(process.execPath,['patch-snapshot-dr.mjs'],candidate);
await exec(process.execPath,['patch-access-ui.mjs'],candidate);
await exec('npm',['install','--prefix','runtime','--omit=dev','--no-audit','--no-fund'],candidate);

const auditPath=path.join(candidate,'runtime','src','audit-integrity.mjs');
let audit=await fs.readFile(auditPath,'utf8');
const before=`export function loadAuditKeyring({ value = process.env.CJ_AUDIT_KEYRING, legacyValue = process.env.CJ_AUDIT_KEY, production = process.env.CJ_ENV === 'production' } = {}) {
  return parseKeyring({ value, legacyValue, envName: 'CJ_AUDIT_KEYRING', legacyEnvName: 'CJ_AUDIT_KEY', production, devSeed: 'central-juridica-development-audit-integrity-key-v1', defaultKeyId: 'audit-legacy-v1' });
}`;
const after=`export function loadAuditKeyring({ value = process.env.CJ_AUDIT_KEYRING, legacyValue = process.env.CJ_AUDIT_KEY, production = process.env.CJ_ENV === 'production' } = {}) {
  const historicalKeyId = String(process.env.CJ_AUDIT_LEGACY_KEY_ID || '').trim();
  let effectiveValue = value;
  if (value && legacyValue && historicalKeyId) {
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(historicalKeyId)) throw new Error('CJ_AUDIT_LEGACY_KEY_ID inválido.');
    let parsed;
    try { parsed = JSON.parse(String(value)); } catch { throw new Error('CJ_AUDIT_KEYRING deve ser JSON válido.'); }
    if (!parsed.keys || typeof parsed.keys !== 'object' || Array.isArray(parsed.keys)) throw new Error('CJ_AUDIT_KEYRING.keys inválido.');
    if (!Object.prototype.hasOwnProperty.call(parsed.keys, historicalKeyId)) {
      parsed = { ...parsed, keys: { ...parsed.keys, [historicalKeyId]: legacyValue } };
      effectiveValue = JSON.stringify(parsed);
    }
  }
  return parseKeyring({ value: effectiveValue, legacyValue, envName: 'CJ_AUDIT_KEYRING', legacyEnvName: 'CJ_AUDIT_KEY', production, devSeed: 'central-juridica-development-audit-integrity-key-v1', defaultKeyId: 'audit-legacy-v1' });
}`;
if((audit.split(before).length-1)!==1) throw new Error('AUDIT_COMPAT_PATCH_MISMATCH');
audit=audit.replace(before,after);
await fs.writeFile(auditPath,audit);

const { createStore } = await import(path.join(candidate,'runtime','src','store-factory.mjs'));
const { loadAuditKeyring, verifyAuditChain } = await import(path.join(candidate,'runtime','src','audit-integrity.mjs'));
const { publicKeyringStatus } = await import(path.join(candidate,'runtime','src','keyring.mjs'));

const dbUrl=new URL(String(process.env.CJ_DATABASE_URL));
dbUrl.pathname='/central_juridica_v32_prod_r3';
if(process.env.CJ_PG_SSL==='true') dbUrl.searchParams.set('sslmode','verify-full');

const runtime=await createStore({databaseUrl:dbUrl.toString()});
try{
  const state=runtime.store.supportsDedicatedAudit ? await runtime.store.readAuditState() : await runtime.store.read();
  const ring=loadAuditKeyring({production:true});
  const status=publicKeyringStatus(ring);
  const verification=verifyAuditChain(state,ring);

  const safe={
    event:'CJ_V32_AUDIT_KEYRING_CANARY',
    passed:verification.ok===true,
    activeKeyId:status.activeKeyId,
    legacyKeyId:status.legacyKeyId,
    knownKeyIds:status.knownKeyIds,
    keyCount:status.keyCount,
    historicalKeyPresent:status.knownKeyIds.includes(HISTORICAL_ID),
    retainedCount:verification.retainedCount,
    errorCodes:(verification.errors||[]).map(e=>e.code),
  };
  console.log(JSON.stringify(safe));
  if(!safe.historicalKeyPresent) throw new Error('HISTORICAL_AUDIT_KEY_NOT_ADDED');
  if(!verification.ok) throw new Error('AUDIT_CHAIN_VERIFY_FAILED_'+safe.errorCodes.join(','));
} finally {
  if(runtime.pool) await runtime.pool.end();
  await fs.rm(root,{recursive:true,force:true});
}
