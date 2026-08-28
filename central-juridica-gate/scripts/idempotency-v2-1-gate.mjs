import crypto from 'node:crypto';
import pg from 'pg';
import { acquireIdempotencyLock, ensureIdempotencyTable, idempotencyDigest, readIdempotencyResult, storeIdempotencyResult } from '../src/postgres-idempotency-v2-1.mjs';

const url=process.env.CJ_DATABASE_URL;if(!url)throw new Error('CJ_DATABASE_URL ausente.');
const pool=new pg.Pool({connectionString:url,max:35});
const secret=crypto.randomBytes(32),phases=[];const phase=(name,ok,extra={})=>{phases.push({name,ok,...extra});if(!ok)throw new Error(`Gate falhou: ${name}`);};
const startedAt=new Date().toISOString();

async function execute(scope,rawKey,{fail=false}={}){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const lock=await acquireIdempotencyLock(client,scope,rawKey,secret);
    const replay=await readIdempotencyResult(client,lock.scope,lock.keyHash);
    if(replay!==null){await client.query('COMMIT');return{...replay,replayed:true};}
    await client.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE FOR UPDATE');
    const inserted=await client.query('INSERT INTO central_juridica_idem_probe_domain(scope,business_key) VALUES($1,$2) RETURNING id',[lock.scope,rawKey]);
    const result={entity:{id:Number(inserted.rows[0].id),scope:lock.scope}};
    if(fail)throw new Error('forced-domain-failure');
    await storeIdempotencyResult(client,lock.scope,lock.keyHash,result);
    await client.query('COMMIT');return result;
  }catch(e){try{await client.query('ROLLBACK');}catch{}throw e;}finally{client.release();}
}

try{
  const version=await pool.query('select version() as version');phase('postgres-connectivity',true,{version:version.rows[0].version});
  await pool.query(`CREATE TABLE IF NOT EXISTS central_juridica_state(singleton boolean PRIMARY KEY DEFAULT TRUE CHECK(singleton=TRUE),state jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`INSERT INTO central_juridica_state(singleton,state) VALUES(TRUE,'{}'::jsonb) ON CONFLICT(singleton) DO NOTHING`);
  await ensureIdempotencyTable(pool);
  await pool.query('DROP TABLE IF EXISTS central_juridica_idem_probe_domain');
  await pool.query('CREATE TABLE central_juridica_idem_probe_domain(id bigserial PRIMARY KEY,scope text NOT NULL,business_key text NOT NULL)');
  await pool.query('DELETE FROM central_juridica_idempotency');
  phase('idempotency-schema-ready',true);

  const columns=(await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='central_juridica_idempotency' ORDER BY ordinal_position`)).rows.map(r=>r.column_name);
  phase('raw-key-column-absent',!columns.some(c=>/raw|idempotency_key/i.test(c)),{columns});
  const raw='predictable-client-key-001',digest=idempotencyDigest('client',raw,secret);
  phase('idempotency-key-hmac',/^[a-f0-9]{64}$/.test(digest)&&!digest.includes(raw),{keyHashPrefix:digest.slice(0,12)});

  const writers=25;const results=await Promise.all(Array.from({length:writers},()=>execute('client',raw)));
  const domainCount=Number((await pool.query('SELECT count(*)::int n FROM central_juridica_idem_probe_domain WHERE scope=$1 AND business_key=$2',['client',raw])).rows[0].n);
  const idemCount=Number((await pool.query('SELECT count(*)::int n FROM central_juridica_idempotency WHERE scope=$1 AND key_hash=$2',['client',digest])).rows[0].n);
  const uniqueIds=new Set(results.map(x=>x.entity.id));const replayed=results.filter(x=>x.replayed).length;
  phase('same-key-concurrency-exactly-once',domainCount===1&&idemCount===1&&uniqueIds.size===1&&replayed===writers-1,{writers,domainCreates:domainCount,idempotencyRows:idemCount,replayed,lostOrDuplicateCreates:domainCount-1});

  const lockClient=await pool.connect();await lockClient.query('BEGIN');await lockClient.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE FOR UPDATE');
  const replayWhileLocked=await Promise.race([execute('client',raw).then(x=>x.replayed===true),new Promise(r=>setTimeout(()=>r(false),1200))]);
  phase('replay-independent-of-state-lock',replayWhileLocked===true);await lockClient.query('ROLLBACK');lockClient.release();

  await assertReject(execute('task','rollback-key',{fail:true}),/forced-domain-failure/);
  const rollbackDomain=Number((await pool.query("SELECT count(*)::int n FROM central_juridica_idem_probe_domain WHERE scope='task' AND business_key='rollback-key'")).rows[0].n);
  const rollbackHash=idempotencyDigest('task','rollback-key',secret);const rollbackIdem=Number((await pool.query('SELECT count(*)::int n FROM central_juridica_idempotency WHERE scope=$1 AND key_hash=$2',['task',rollbackHash])).rows[0].n);
  phase('domain-and-idempotency-rollback-atomic',rollbackDomain===0&&rollbackIdem===0);

  const sameRawOtherScope=await execute('process',raw);phase('scope-isolation',sameRawOtherScope.entity.scope==='process'&&idempotencyDigest('process',raw,secret)!==digest);

  const stored=(await pool.query('SELECT scope,key_hash,response::text AS response FROM central_juridica_idempotency')).rows;
  phase('raw-key-not-persisted',stored.every(r=>!String(r.key_hash).includes(raw)&&!String(r.response).includes(raw)),{rows:stored.length});

  const summary={dedicatedIdempotencyTable:true,hmacKeyStorage:true,rawKeyPersisted:false,concurrentRequests:writers,domainCreates:1,replays:writers-1,duplicateCreates:0,replayOutsideGlobalLock:true,rollbackAtomicity:true,scopeIsolation:true};
  console.log(JSON.stringify({ok:true,evidence:{runId:crypto.randomUUID(),startedAt,phases,finishedAt:new Date().toISOString(),summary}},null,2));
}finally{await pool.end();}

async function assertReject(promise,rx){let caught=null;try{await promise;}catch(e){caught=e;}if(!caught||!rx.test(String(caught.message)))throw new Error('Expected rejection not observed');}
