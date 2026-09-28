import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const RELEASE = 'd507a9955be07ef710d410b5263686ac75caeeff';
const SOURCE_DB = 'central_juridica_prod_v311';
const TARGET_DB = 'central_juridica_v32_prod_r3';

const enabled = String(process.env.CJ_CANONICAL_USER_SYNC || '').trim() === 'true';
if (!enabled) {
  console.log(JSON.stringify({ event:'CANONICAL_USER_SYNC_SKIPPED', enabled:false }));
  process.exit(0);
}

const username = String(process.env.CJ_CANONICAL_USER_SYNC_USERNAME || '').trim().toLowerCase();
const nonce = String(process.env.CJ_CANONICAL_USER_SYNC_NONCE || '').trim();
const databaseBase = String(process.env.CJ_ADMIN_RESYNC_DATABASE_URL || '').trim();
const pgSsl = String(process.env.CJ_ADMIN_RESYNC_PG_SSL || '').trim() === 'true';

if (!/^[a-z0-9._-]{3,80}$/.test(username)) throw new Error('CANONICAL_USER_SYNC_USERNAME_POLICY_FAILED');
if (username === 'admin' || username.startsWith('qa_')) throw new Error('CANONICAL_USER_SYNC_PROTECTED_ACCOUNT');
if (!/^[A-Za-z0-9._:-]{12,120}$/.test(nonce)) throw new Error('CANONICAL_USER_SYNC_NONCE_POLICY_FAILED');
if (!databaseBase) throw new Error('CANONICAL_USER_SYNC_DATABASE_REFERENCE_MISSING');

function exec(cmd,args,cwd,env=process.env){
  return new Promise((resolve,reject)=>{
    const child=spawn(cmd,args,{cwd,env,stdio:'inherit'});
    child.once('error',reject);
    child.once('exit',code=>code===0?resolve():reject(new Error(cmd+'_FAILED_'+code)));
  });
}

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+stable(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function databaseUrl(raw, databaseName) {
  const url = new URL(raw);
  url.pathname = '/' + databaseName;
  if (pgSsl) url.searchParams.set('sslmode','verify-full');
  return url.toString();
}

const root=await fs.mkdtemp(path.join(os.tmpdir(),'cj-canonical-user-sync-'));
try {
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
  const beforePatch=`export function loadAuditKeyring({ value = process.env.CJ_AUDIT_KEYRING, legacyValue = process.env.CJ_AUDIT_KEY, production = process.env.CJ_ENV === 'production' } = {}) {
  return parseKeyring({ value, legacyValue, envName: 'CJ_AUDIT_KEYRING', legacyEnvName: 'CJ_AUDIT_KEY', production, devSeed: 'central-juridica-development-audit-integrity-key-v1', defaultKeyId: 'audit-legacy-v1' });
}`;
  const afterPatch=`export function loadAuditKeyring({ value = process.env.CJ_AUDIT_KEYRING, legacyValue = process.env.CJ_AUDIT_KEY, production = process.env.CJ_ENV === 'production' } = {}) {
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
  if((audit.split(beforePatch).length-1)!==1) throw new Error('CANONICAL_USER_SYNC_AUDIT_PATCH_MISMATCH');
  audit=audit.replace(beforePatch,afterPatch);
  await fs.writeFile(auditPath,audit);

  const { appendAuditEntry, initializeAuditChain, loadAuditKeyring } =
    await import(path.join(candidate,'runtime','src','audit-integrity.mjs'));
  const { persistAuditDelta, readAuditState } =
    await import(path.join(candidate,'runtime','src','postgres-audit.mjs'));

  const require=createRequire(path.join(candidate,'runtime','package.json'));
  const { Pool }=require('pg');

  const poolOpts=(connectionString,app)=>({
    connectionString,
    max:1,
    connectionTimeoutMillis:10000,
    statement_timeout:30000,
    application_name:app,
    ssl:pgSsl?{rejectUnauthorized:true}:undefined
  });

  const sourcePool=new Pool(poolOpts(databaseUrl(databaseBase,SOURCE_DB),'central-juridica-canonical-user-source'));
  const targetPool=new Pool(poolOpts(databaseUrl(databaseBase,TARGET_DB),'central-juridica-canonical-user-target'));
  const auditKeyring=loadAuditKeyring({production:true});

  let sourceRow;
  let sourceSessions=0;
  const sourceClient=await sourcePool.connect();
  try {
    await sourceClient.query('BEGIN READ ONLY');
    const selected=await sourceClient.query(
      'SELECT user_id,username_normalized,payload,updated_at FROM central_juridica_users WHERE username_normalized=$1',
      [username]
    );
    if(selected.rowCount!==1) throw new Error('CANONICAL_USER_SYNC_SOURCE_USER_NOT_FOUND');
    sourceRow=selected.rows[0];

    const sessions=await sourceClient.query(
      'SELECT count(*)::int AS count FROM central_juridica_sessions WHERE user_id=$1',
      [sourceRow.user_id]
    );
    sourceSessions=Number(sessions.rows?.[0]?.count || 0);
    if(sourceSessions!==0) throw new Error('CANONICAL_USER_SYNC_SOURCE_SESSION_ACTIVE');

    const payload=sourceRow.payload;
    if(!payload || typeof payload!=='object' || Array.isArray(payload)) throw new Error('CANONICAL_USER_SYNC_SOURCE_PAYLOAD_INVALID');
    if(String(payload.username||'').trim().toLowerCase()!==username) throw new Error('CANONICAL_USER_SYNC_SOURCE_USERNAME_MISMATCH');
    if(payload.role!=='lawyer') throw new Error('CANONICAL_USER_SYNC_ROLE_NOT_ALLOWED');
    if(payload.active!==true) throw new Error('CANONICAL_USER_SYNC_SOURCE_INACTIVE');
    if(typeof payload.passwordHash!=='string' || payload.passwordHash.length<20) throw new Error('CANONICAL_USER_SYNC_SOURCE_CREDENTIAL_MISSING');
    await sourceClient.query('COMMIT');
  } catch(error) {
    try{await sourceClient.query('ROLLBACK');}catch{}
    throw error;
  } finally {
    sourceClient.release();
  }

  const targetClient=await targetPool.connect();
  try {
    await targetClient.query('BEGIN');

    const existing=await targetClient.query(
      'SELECT user_id,username_normalized,payload,updated_at FROM central_juridica_users WHERE username_normalized=$1 FOR UPDATE',
      [username]
    );

    if(existing.rowCount===1) {
      const row=existing.rows[0];
      const identical =
        String(row.user_id)===String(sourceRow.user_id) &&
        String(row.username_normalized)===String(sourceRow.username_normalized) &&
        stable(row.payload)===stable(sourceRow.payload);
      if(!identical) throw new Error('CANONICAL_USER_SYNC_TARGET_CONFLICT');
      await targetClient.query('COMMIT');
      console.log(JSON.stringify({
        event:'CANONICAL_USER_SYNC_COMPLETE',
        passed:true,
        username,
        inserted:false,
        idempotent:true,
        role:sourceRow.payload.role,
        active:sourceRow.payload.active===true,
        credentialHashPreserved:true,
        mfaStatePreserved:true,
        sourceSessions,
        targetSessions:0,
        nonce
      }));
    } else if(existing.rowCount===0) {
      const targetSessionsBefore=await targetClient.query(
        'SELECT count(*)::int AS count FROM central_juridica_sessions WHERE user_id=$1',
        [sourceRow.user_id]
      );
      if(Number(targetSessionsBefore.rows?.[0]?.count || 0)!==0) throw new Error('CANONICAL_USER_SYNC_TARGET_ORPHAN_SESSION');

      await targetClient.query(
        'INSERT INTO central_juridica_users (user_id,username_normalized,payload,updated_at) VALUES ($1,$2,$3::jsonb,$4)',
        [sourceRow.user_id,sourceRow.username_normalized,JSON.stringify(sourceRow.payload),sourceRow.updated_at]
      );

      const persisted=await targetClient.query(
        'SELECT user_id,username_normalized,payload FROM central_juridica_users WHERE username_normalized=$1',
        [username]
      );
      if(persisted.rowCount!==1) throw new Error('CANONICAL_USER_SYNC_PERSIST_VERIFY_MISSING');
      const targetRow=persisted.rows[0];
      if(String(targetRow.user_id)!==String(sourceRow.user_id)) throw new Error('CANONICAL_USER_SYNC_USER_ID_MISMATCH');
      if(stable(targetRow.payload)!==stable(sourceRow.payload)) throw new Error('CANONICAL_USER_SYNC_PAYLOAD_MISMATCH');
      if(targetRow.payload.passwordHash!==sourceRow.payload.passwordHash) throw new Error('CANONICAL_USER_SYNC_CREDENTIAL_HASH_MISMATCH');
      if(stable(targetRow.payload.mfa ?? null)!==stable(sourceRow.payload.mfa ?? null)) throw new Error('CANONICAL_USER_SYNC_MFA_STATE_MISMATCH');

      const targetSessionsAfter=await targetClient.query(
        'SELECT count(*)::int AS count FROM central_juridica_sessions WHERE user_id=$1',
        [sourceRow.user_id]
      );
      const targetSessions=Number(targetSessionsAfter.rows?.[0]?.count || 0);
      if(targetSessions!==0) throw new Error('CANONICAL_USER_SYNC_SESSION_CREATED');

      const current=await readAuditState(targetClient,{forUpdate:true});
      if(!current.auditMeta?.initialized) initializeAuditChain(current,auditKeyring);
      const auditBefore=structuredClone(current);
      const now=new Date().toISOString();
      appendAuditEntry(current,{
        id:'audit_'+crypto.randomUUID(),
        action:'CANONICAL_USER_MIGRATED',
        entity:'user',
        entityId:String(sourceRow.user_id),
        requestId:'canonical_user_sync_'+nonce,
        actor:null,
        detail:{
          controlled:true,
          username,
          sourceDatabase:SOURCE_DB,
          targetDatabase:TARGET_DB,
          credentialHashPreserved:true,
          mfaStatePreserved:true,
          sourceSessions,
          targetSessions,
          sessionsMigrated:false,
          nonce
        },
        at:now
      },auditKeyring);
      await persistAuditDelta(targetClient,auditBefore,current,auditKeyring);

      await targetClient.query('COMMIT');
      console.log(JSON.stringify({
        event:'CANONICAL_USER_SYNC_COMPLETE',
        passed:true,
        username,
        inserted:true,
        idempotent:false,
        role:sourceRow.payload.role,
        active:sourceRow.payload.active===true,
        credentialHashPreserved:true,
        mfaStatePreserved:true,
        sourceSessions,
        targetSessions,
        nonce
      }));
    } else {
      throw new Error('CANONICAL_USER_SYNC_TARGET_DUPLICATE');
    }
  } catch(error) {
    try{await targetClient.query('ROLLBACK');}catch{}
    throw error;
  } finally {
    targetClient.release();
    await sourcePool.end();
    await targetPool.end();
  }
} finally {
  await fs.rm(root,{recursive:true,force:true});
}
