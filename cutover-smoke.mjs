import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const mod = async (name, q='') => import(pathToFileURL(path.join(root,'runtime','src',name)).href + q);
const { createStore } = await mod('store-factory.mjs');
const { loadMfaKeyring, openMfaSecret, totpCode } = await mod('mfa.mjs');
const { createBackup, verifyBackup, restoreBackup } = await mod('backup.mjs');
const { verifyAuditChain, loadAuditKeyring } = await mod('audit-integrity.mjs');
const evidence=[];
const phase=(name,extra={})=>{ evidence.push({name,ok:true,...extra}); console.log(JSON.stringify({event:'cutover-smoke',phase:name,ok:true,...extra})); };
const fail=(name,err)=>{ console.error(JSON.stringify({event:'cutover-smoke',phase:name,ok:false,error:String(err?.message||err)})); throw err; };
const base=String(process.env.CJ_PUBLIC_BASE_URL||'').replace(/\/$/,'');
assert.match(base,/^https:\/\//);
const prodUrl=process.env.CJ_DATABASE_URL;
assert.ok(prodUrl,'CJ_DATABASE_URL missing');
const adminUser=process.env.CJ_ADMIN_USER||'admin';
const adminPassword=process.env.CJ_ADMIN_PASSWORD;
assert.ok(adminPassword,'CJ_ADMIN_PASSWORD missing');

async function request(baseUrl, method, pathname, {cookie, body, headers={}}={}) {
  const h={...headers};
  if(body!==undefined) h['content-type']='application/json';
  if(cookie) h.cookie=cookie;
  if(['POST','PATCH','PUT','DELETE'].includes(method)) h.origin=baseUrl;
  const r=await fetch(baseUrl+pathname,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
  const buf=Buffer.from(await r.arrayBuffer());
  let json=null; try{json=JSON.parse(buf.toString('utf8'));}catch{}
  return {status:r.status,headers:r.headers,buf,json};
}
function cookieFrom(r){return String(r.headers.get('set-cookie')||'').split(';')[0];}
function assertStatus(r,status,label){assert.equal(r.status,status,`${label}: HTTP ${r.status} ${r.buf.toString('utf8').slice(0,300)}`);}

let prodStore,prodPool,isoStore,isoPool,server,schema,backupRoot;
try{
  const prod=await createStore({databaseUrl:prodUrl}); prodStore=prod.store; prodPool=prod.pool; await prodStore.init();
  const admin=await prodStore.findUserByUsername(adminUser); assert.ok(admin&&admin.active!==false,'admin ativo não encontrado');
  const mfaRing=loadMfaKeyring();
  let mfaCode; if(admin.mfa?.enabled) mfaCode=totpCode(openMfaSecret(admin.mfa.secretSealed,mfaRing));

  let r=await request(base,'GET','/api/health'); assertStatus(r,200,'health'); assert.equal(r.json?.version,'3.1.1'); phase('public-health',{version:r.json.version,backend:r.json.backend});
  r=await request(base,'GET','/api/ready'); assertStatus(r,200,'ready'); assert.equal(r.json?.ok,true); phase('public-ready',{backend:r.json.backend});
  r=await request(base,'GET','/api/san/openapi.json'); assertStatus(r,200,'san-openapi'); assert.equal(r.json?.openapi,'3.1.0'); phase('san-public-contract',{contractVersion:r.json?.info?.version});

  const loginBody={username:adminUser,password:adminPassword}; if(mfaCode) loginBody.mfaCode=mfaCode;
  r=await request(base,'POST','/api/login',{body:loginBody}); assertStatus(r,200,'production admin login'); assert.equal(r.json?.mfaEnrollmentRequired,false,'admin MFA enrollment required'); const prodCookie=cookieFrom(r); assert.ok(prodCookie.startsWith('cj_session=')); phase('production-admin-login',{mfaEnabled:Boolean(admin.mfa?.enabled)});
  r=await request(base,'GET','/api/session',{cookie:prodCookie}); assertStatus(r,200,'production session'); assert.equal(r.json?.authenticated,true); phase('production-session');
  r=await request(base,'POST','/api/logout',{cookie:prodCookie,body:{}}); assertStatus(r,200,'production logout');
  r=await request(base,'GET','/api/session',{cookie:prodCookie}); assertStatus(r,200,'revoked production session'); assert.equal(r.json?.authenticated,false); phase('production-session-revocation');

  backupRoot=path.join('/tmp',`cj-cutover-backup-${Date.now()}`); await fs.mkdir(backupRoot,{recursive:true,mode:0o700});
  const backup=await createBackup({store:prodStore,documentDir:'/tmp/cj-docs',backupRoot,backend:'postgres'});
  const verified=await verifyBackup(backup.target); assert.equal(verified.ok,true,JSON.stringify(verified.errors)); phase('encrypted-backup-verified',{version:backup.manifest.version,documents:backup.manifest.documents.length,keyId:Boolean(backup.manifest.crypto?.keyId)});

  schema=`cj_cutover_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`; assert.match(schema,/^[a-z0-9_]+$/); await prodPool.query(`CREATE SCHEMA "${schema}"`);
  const u=new URL(prodUrl); u.searchParams.set('options',`-c search_path=${schema}`); const isolatedUrl=u.toString();
  const iso=await createStore({databaseUrl:isolatedUrl}); isoStore=iso.store; isoPool=iso.pool; await isoStore.init();
  const restored=await restoreBackup({store:isoStore,documentDir:'/tmp/cj-restore-docs',target:backup.target,backend:'postgres'}); assert.equal(restored.ok,true); const sess=await isoPool.query('SELECT count(*)::int AS n FROM central_juridica_sessions'); assert.equal(sess.rows[0].n,0); phase('isolated-restore',{restoredDocuments:restored.restoredDocuments,sessionsRestored:0});
  const auditView=await isoStore.readAuditView(); assert.equal(verifyAuditChain(auditView,loadAuditKeyring()).ok,true); phase('isolated-audit-integrity');

  process.env.CJ_DATABASE_URL=isolatedUrl; process.env.CJ_SAN_ENABLED='false';
  const { default: handler }=await mod('server.mjs',`?cutover=${Date.now()}`);
  server=http.createServer((req,res)=>handler(req,res)); await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const local=`http://127.0.0.1:${server.address().port}`;

  const isoAdmin=await isoStore.findUserByUsername(adminUser); assert.ok(isoAdmin); let isoMfa; if(isoAdmin.mfa?.enabled) isoMfa=totpCode(openMfaSecret(isoAdmin.mfa.secretSealed,mfaRing));
  const localLogin={username:adminUser,password:adminPassword}; if(isoMfa)localLogin.mfaCode=isoMfa;
  r=await request(local,'POST','/api/login',{body:localLogin}); assertStatus(r,200,'isolated admin login'); const adminCookie=cookieFrom(r); phase('isolated-admin-login');

  const stamp=Date.now().toString(36); const idem=`cutover-${stamp}`;
  const clientBody={name:`CUTOVER SMOKE ${stamp}`,type:'Empresa',contact:'Smoke',email:'',phone:'',status:'Ativo'};
  const c1=await request(local,'POST','/api/clients',{cookie:adminCookie,body:clientBody,headers:{'idempotency-key':`${idem}-client`}}); assertStatus(c1,201,'client create'); const c2=await request(local,'POST','/api/clients',{cookie:adminCookie,body:clientBody,headers:{'idempotency-key':`${idem}-client`}}); assertStatus(c2,200,'client replay'); assert.equal(c1.json.client.id,c2.json.client.id); phase('client-idempotency'); const clientId=c1.json.client.id;
  const p1=await request(local,'POST','/api/processes',{cookie:adminCookie,body:{title:`Processo smoke ${stamp}`,clientId,area:'Cível',status:'Ativo',risk:'Baixo',stage:'Validação de cutover',facts:'Dado sintético',ourThesis:'N/A',evidence:'N/A',strategy:'N/A',nextAction:'Remover após validação'},headers:{'idempotency-key':`${idem}-process`}}); assertStatus(p1,201,'process create'); const processId=p1.json.process.id; phase('process-create');
  const t1=await request(local,'POST','/api/tasks',{cookie:adminCookie,body:{title:`Tarefa smoke ${stamp}`,processId,priority:'Média',status:'Pendente',owner:'Smoke'},headers:{'idempotency-key':`${idem}-task`}}); assertStatus(t1,201,'task create'); phase('task-create');

  const plain=Buffer.from(`central-juridica-cutover-${stamp}`,'utf8');
  const d1=await request(local,'POST','/api/documents',{cookie:adminCookie,body:{name:`cutover-${stamp}.txt`,mimeType:'text/plain',processId,base64:plain.toString('base64')},headers:{'idempotency-key':`${idem}-doc`}}); assertStatus(d1,201,'document upload'); const doc=d1.json.document; assert.equal(doc.encrypted,true); assert.equal(doc.storageBackend,'postgres');
  const down=await request(local,'GET',`/api/documents/${doc.id}/content`,{cookie:adminCookie}); assertStatus(down,200,'document download'); assert.equal(down.buf.equals(plain),true); phase('document-encrypted-roundtrip',{sha256:doc.sha256===crypto.createHash('sha256').update(plain).digest('hex')});

  const tempPassword=`Tmp!${crypto.randomBytes(16).toString('base64url')}9a`; const tempUser=`smoke_${stamp}`;
  const ur=await request(local,'POST','/api/users',{cookie:adminCookie,body:{username:tempUser,name:'Cutover Smoke Assistant',role:'assistant',password:tempPassword},headers:{'idempotency-key':`${idem}-user`}}); assertStatus(ur,201,'assistant create');
  const al=await request(local,'POST','/api/login',{body:{username:tempUser,password:tempPassword}}); assertStatus(al,200,'assistant login'); const assistantCookie=cookieFrom(al);
  const forbidden=await request(local,'GET','/api/users',{cookie:assistantCookie}); assert.equal(forbidden.status,403); phase('rbac-deny'); await request(local,'POST','/api/logout',{cookie:assistantCookie,body:{}});

  for(let i=1;i<=10;i++){const bad=await request(local,'POST','/api/login',{body:{username:`rate_${stamp}`,password:'definitely-wrong-password'}}); assert.equal(bad.status,401,`rate attempt ${i}`);}
  const blocked=await request(local,'POST','/api/login',{body:{username:`rate_${stamp}`,password:'definitely-wrong-password'}}); assert.equal(blocked.status,429); assert.ok(Number(blocked.headers.get('retry-after')||0)>=1); phase('shared-rate-limit');
  const ai=await request(local,'GET','/api/audit/integrity',{cookie:adminCookie}); assertStatus(ai,200,'audit integrity endpoint'); assert.equal(ai.json?.ok,true); phase('audit-integrity-endpoint');
  const ag=await request(local,'GET','/api/audit/gates',{cookie:adminCookie}); assertStatus(ag,200,'audit gates'); phase('audit-gates',{status:ag.json?.status||null});
  await request(local,'POST','/api/logout',{cookie:adminCookie,body:{}}); phase('cutover-operational-smoke-complete',{phases:evidence.length+1});
  console.log(JSON.stringify({event:'cutover-smoke-summary',ok:true,phases:evidence.map(x=>x.name)}));
} catch(err){ fail('fatal',err); }
finally{
  try{if(server) await new Promise(resolve=>server.close(()=>resolve()));}catch{}
  try{if(isoPool) await isoPool.end();}catch{}
  try{if(prodPool && schema) await prodPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}catch(e){console.error(JSON.stringify({event:'cutover-smoke-cleanup',ok:false,error:String(e.message)}));}
  try{if(prodPool) await prodPool.end();}catch{}
  try{if(backupRoot) await fs.rm(backupRoot,{recursive:true,force:true});}catch{}
}
