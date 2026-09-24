import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const RELEASE = 'd507a9955be07ef710d410b5263686ac75caeeff';
const enabled = String(process.env.CJ_ADMIN_CREDENTIAL_RESYNC || '').trim() === 'true';
const nonce = String(process.env.CJ_ADMIN_CREDENTIAL_RESYNC_NONCE || '').trim();

if (!enabled) {
  console.log(JSON.stringify({ event:'ADMIN_CREDENTIAL_RESYNC_SKIPPED', enabled:false }));
  process.exit(0);
}
if (!/^[A-Za-z0-9._:-]{12,120}$/.test(nonce)) throw new Error('ADMIN_RESYNC_NONCE_POLICY_FAILED');

const username = String(process.env.CJ_ADMIN_USER || '').trim().toLowerCase();
const password = String(process.env.CJ_ADMIN_PASSWORD || '');
const databaseBase = String(process.env.CJ_DATABASE_URL || '').trim();

if (!username || username.startsWith('qa_')) throw new Error('ADMIN_RESYNC_USERNAME_POLICY_FAILED');
if (password.length < 14 || password.length > 128) throw new Error('ADMIN_RESYNC_PASSWORD_POLICY_FAILED');
if (!databaseBase) throw new Error('ADMIN_RESYNC_DATABASE_URL_MISSING');

function exec(cmd,args,cwd,env=process.env){
  return new Promise((resolve,reject)=>{
    const child=spawn(cmd,args,{cwd,env,stdio:'inherit'});
    child.once('error',reject);
    child.once('exit',code=>code===0?resolve():reject(new Error(cmd+'_FAILED_'+code)));
  });
}

const root=await fs.mkdtemp(path.join(os.tmpdir(),'cj-admin-resync-'));
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
  if((audit.split(beforePatch).length-1)!==1) throw new Error('ADMIN_RESYNC_AUDIT_PATCH_MISMATCH');
  audit=audit.replace(beforePatch,afterPatch);
  await fs.writeFile(auditPath,audit);

  const { hashPassword, verifyPassword } = await import(path.join(candidate,'runtime','src','auth.mjs'));
  const { appendAuditEntry, initializeAuditChain, loadAuditKeyring } = await import(path.join(candidate,'runtime','src','audit-integrity.mjs'));
  const { persistAuditDelta, readAuditState } = await import(path.join(candidate,'runtime','src','postgres-audit.mjs'));

  const require=createRequire(path.join(candidate,'runtime','package.json'));
  const { Pool }=require('pg');

  const dbUrl=new URL(databaseBase);
  dbUrl.pathname='/central_juridica_v32_prod_r3';
  if(process.env.CJ_PG_SSL==='true') dbUrl.searchParams.set('sslmode','verify-full');

  const pool=new Pool({
    connectionString:dbUrl.toString(),
    max:1,
    connectionTimeoutMillis:10000,
    statement_timeout:30000,
    application_name:'central-juridica-admin-credential-resync',
    ssl:process.env.CJ_PG_SSL==='true'?{rejectUnauthorized:true}:undefined
  });

  const auditKeyring=loadAuditKeyring({production:true});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');

    const selected=await client.query(
      'SELECT user_id,payload FROM central_juridica_users WHERE username_normalized=$1 FOR UPDATE',
      [username]
    );
    if(selected.rowCount!==1) throw new Error('ADMIN_RESYNC_USER_NOT_FOUND');

    const userId=String(selected.rows[0].user_id || '');
    const original=structuredClone(selected.rows[0].payload || {});
    if(!userId || !original || typeof original!=='object' || Array.isArray(original)) throw new Error('ADMIN_RESYNC_USER_PAYLOAD_INVALID');
    if(String(original.username || '').toLowerCase()!==username) throw new Error('ADMIN_RESYNC_USERNAME_MISMATCH');
    if(original.active!==true) throw new Error('ADMIN_RESYNC_ADMIN_INACTIVE');

    const sanitizeNonPasswordState=(value)=>{
      const clone=structuredClone(value);
      delete clone.passwordHash;
      delete clone.passwordChangedAt;
      delete clone.updatedAt;
      return clone;
    };
    const protectedBefore=JSON.stringify(sanitizeNonPasswordState(original));

    const sessionsBeforeResult=await client.query(
      'SELECT count(*)::int AS count FROM central_juridica_sessions WHERE user_id=$1',
      [userId]
    );
    const sessionsBefore=Number(sessionsBeforeResult.rows?.[0]?.count || 0);

    const previousPasswordMatched=await verifyPassword(password,original.passwordHash);
    const now=new Date().toISOString();
    const updated=structuredClone(original);
    updated.passwordHash=await hashPassword(password);
    updated.passwordChangedAt=now;
    updated.updatedAt=now;

    const protectedAfter=JSON.stringify(sanitizeNonPasswordState(updated));
    if(protectedBefore!==protectedAfter) throw new Error('ADMIN_RESYNC_NON_PASSWORD_STATE_CHANGED');

    await client.query(
      'UPDATE central_juridica_users SET payload=$2::jsonb,updated_at=now() WHERE user_id=$1',
      [userId,JSON.stringify(updated)]
    );

    await client.query('DELETE FROM central_juridica_sessions WHERE user_id=$1',[userId]);
    const sessionsAfterResult=await client.query(
      'SELECT count(*)::int AS count FROM central_juridica_sessions WHERE user_id=$1',
      [userId]
    );
    const sessionsAfter=Number(sessionsAfterResult.rows?.[0]?.count || 0);
    if(sessionsAfter!==0) throw new Error('ADMIN_RESYNC_SESSIONS_NOT_REVOKED');

    const persisted=await client.query(
      'SELECT payload FROM central_juridica_users WHERE user_id=$1',
      [userId]
    );
    const persistedUser=structuredClone(persisted.rows?.[0]?.payload || {});
    const passwordVerified=await verifyPassword(password,persistedUser.passwordHash);
    const nonPasswordStatePreserved=
      JSON.stringify(sanitizeNonPasswordState(persistedUser))===protectedBefore;
    if(!passwordVerified) throw new Error('ADMIN_RESYNC_PASSWORD_VERIFY_FAILED');
    if(!nonPasswordStatePreserved) throw new Error('ADMIN_RESYNC_MFA_OR_PROFILE_STATE_CHANGED');

    const current=await readAuditState(client,{forUpdate:true});
    if(!current.auditMeta?.initialized) initializeAuditChain(current,auditKeyring);
    const auditBefore=structuredClone(current);
    appendAuditEntry(current,{
      id:'audit_'+crypto.randomUUID(),
      action:'ADMIN_CREDENTIAL_RESYNCED',
      entity:'user',
      entityId:userId,
      requestId:'admin_resync_'+nonce,
      actor:null,
      detail:{
        controlled:true,
        providerSecretAuthority:true,
        previousPasswordMatched,
        passwordRehashed:true,
        sessionsBefore,
        sessionsRevoked:sessionsBefore,
        sessionsAfter,
        nonPasswordStatePreserved:true,
        mfaKeyMaterialTouched:false,
        resyncNonce:nonce
      },
      at:now
    },auditKeyring);
    await persistAuditDelta(client,auditBefore,current,auditKeyring);

    await client.query('COMMIT');

    console.log(JSON.stringify({
      event:'ADMIN_CREDENTIAL_RESYNC_COMPLETE',
      passed:true,
      previousPasswordMatched,
      passwordVerified:true,
      passwordRehashed:true,
      sessionsBefore,
      sessionsRevoked:sessionsBefore,
      sessionsAfter:0,
      nonPasswordStatePreserved:true,
      mfaKeyMaterialTouched:false,
      nonce
    }));
  } catch(error) {
    try{await client.query('ROLLBACK');}catch{}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
} finally {
  await fs.rm(root,{recursive:true,force:true});
}
