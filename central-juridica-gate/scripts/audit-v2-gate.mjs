import crypto from 'node:crypto';
import pg from 'pg';
import { appendDedicatedAudit, ensureAuditTables, migrateLegacyJsonbAudit, readAuditState, replaceAuditState } from '../src/postgres-audit-v2.mjs';
import { makeLegacyState, verifyAudit } from '../src/audit-integrity-v1-6.mjs';

const url = process.env.CJ_DATABASE_URL;
if (!url) throw new Error('CJ_DATABASE_URL ausente.');
const pool = new pg.Pool({ connectionString: url, max: 30 });
const phases = [];
const phase = (name, ok, extra={}) => { phases.push({ name, ok, ...extra }); if (!ok) throw new Error(`Gate falhou: ${name}`); };
const oldKey = crypto.randomBytes(32), newKey = crypto.randomBytes(32);
const ring = { activeKeyId:'audit-v2-new', legacyKeyId:'audit-v2-old', source:'ci-v2', keys:new Map([['audit-v2-old',oldKey],['audit-v2-new',newKey]]) };
const startedAt = new Date().toISOString();

try {
  const version = await pool.query('select version() as version');
  phase('postgres-connectivity', true, { version: version.rows[0].version });
  await pool.query(`CREATE TABLE IF NOT EXISTS central_juridica_state(singleton boolean PRIMARY KEY DEFAULT TRUE CHECK(singleton=TRUE), state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`INSERT INTO central_juridica_state(singleton,state) VALUES(TRUE,'{}'::jsonb) ON CONFLICT(singleton) DO NOTHING`);
  await pool.query('DROP TABLE IF EXISTS central_juridica_audit_log');
  await pool.query('DROP TABLE IF EXISTS central_juridica_audit_meta');
  await ensureAuditTables(pool);
  phase('audit-schema-ready', true);

  const legacy = makeLegacyState([
    {id:'legacy-2',action:'UPDATE',entity:'case',entityId:'p1',requestId:'r2',actor:{id:'u1',role:'admin'},detail:{n:2},at:'2026-08-28T08:01:00.000Z'},
    {id:'legacy-1',action:'CREATE',entity:'case',entityId:'p1',requestId:'r1',actor:{id:'u1',role:'admin'},detail:{n:1},at:'2026-08-28T08:00:00.000Z'}
  ], oldKey, { legacyKeyId:'audit-v2-old' });
  const originalHashes = legacy.auditLog.map(e=>e.hash);
  const migrationClient = await pool.connect();
  try {
    await migrationClient.query('BEGIN');
    await migrationClient.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE FOR UPDATE');
    await migrationClient.query('UPDATE central_juridica_state SET state=$1::jsonb,updated_at=now() WHERE singleton=TRUE',[JSON.stringify(legacy)]);
    const working = structuredClone(legacy);
    const migrated = await migrateLegacyJsonbAudit(migrationClient, working, ring);
    await migrationClient.query('UPDATE central_juridica_state SET state=$1::jsonb,updated_at=now() WHERE singleton=TRUE',[JSON.stringify(working)]);
    await migrationClient.query('COMMIT');
    phase('legacy-jsonb-audit-migrated', migrated.migrated === true);
  } catch (e) { try { await migrationClient.query('ROLLBACK'); } catch {} throw e; } finally { migrationClient.release(); }

  const physical = await pool.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE');
  const dedicatedAfterMigration = await readAuditState(pool);
  phase('audit-outside-jsonb', Array.isArray(physical.rows[0].state.auditLog) && physical.rows[0].state.auditLog.length===0 && Object.keys(physical.rows[0].state.auditMeta||{}).length===0);
  phase('legacy-hashes-preserved', dedicatedAfterMigration.auditLog.map(e=>e.hash).join('|')===originalHashes.join('|'));
  phase('legacy-chain-valid-after-migration', verifyAudit(dedicatedAfterMigration,ring).ok===true, { entries:dedicatedAfterMigration.auditLog.length });

  const stateLock = await pool.connect();
  await stateLock.query('BEGIN');
  await stateLock.query('SELECT state FROM central_juridica_state WHERE singleton=TRUE FOR UPDATE');
  const independent = await Promise.race([
    appendDedicatedAudit(pool,{id:'independent-append',action:'LOGIN',entity:'session',entityId:'u1',requestId:'independent',actor:{id:'u1',role:'admin'},detail:{probe:true},at:new Date().toISOString()},ring).then(()=>true),
    new Promise(resolve=>setTimeout(()=>resolve(false),1500))
  ]);
  phase('audit-append-independent-of-state-lock', independent===true);
  await stateLock.query('ROLLBACK'); stateLock.release();

  const writers = 25;
  await Promise.all(Array.from({length:writers},(_,i)=>appendDedicatedAudit(pool,{id:`concurrent-${i}`,action:'READ',entity:'audit-probe',entityId:String(i),requestId:`req-${i}`,actor:null,detail:{i},at:new Date(Date.now()+i).toISOString()},ring)));
  const concurrentState = await readAuditState(pool);
  const validConcurrent = verifyAudit(concurrentState,ring);
  const tableCount = Number((await pool.query('SELECT count(*)::int AS n FROM central_juridica_audit_log')).rows[0].n);
  phase('audit-append-concurrency', validConcurrent.ok && tableCount===legacy.auditLog.length+1+writers, { writers, persisted:tableCount, lostAppends:(legacy.auditLog.length+1+writers)-tableCount });
  const dup = Number((await pool.query('SELECT count(*)::int AS n FROM (SELECT entry_id FROM central_juridica_audit_log GROUP BY entry_id HAVING count(*)>1) x')).rows[0].n);
  phase('audit-log-append-only-unique', dup===0);

  const newest = concurrentState.auditLog[0];
  await pool.query(`UPDATE central_juridica_audit_log SET payload=jsonb_set(payload,'{detail,tampered}','true'::jsonb,true) WHERE entry_id=$1`,[newest.id]);
  const tampered = verifyAudit(await readAuditState(pool),ring);
  phase('audit-entry-tamper-detected', tampered.ok===false && tampered.errors.some(e=>e.code==='HASH_MISMATCH'), { errors:tampered.errors.map(e=>e.code) });
  await pool.query('UPDATE central_juridica_audit_log SET payload=$1::jsonb WHERE entry_id=$2',[JSON.stringify(newest),newest.id]);

  const goodMeta = structuredClone((await readAuditState(pool)).auditMeta);
  await pool.query(`UPDATE central_juridica_audit_meta SET payload=jsonb_set(payload,'{retainedCount}',to_jsonb((payload->>'retainedCount')::int - 1),false) WHERE singleton=TRUE`);
  const metaTampered = verifyAudit(await readAuditState(pool),ring);
  phase('audit-metadata-tamper-detected', metaTampered.ok===false && metaTampered.errors.some(e=>e.code==='META_MAC_MISMATCH'), { errors:metaTampered.errors.map(e=>e.code) });
  await pool.query('UPDATE central_juridica_audit_meta SET payload=$1::jsonb WHERE singleton=TRUE',[JSON.stringify(goodMeta)]);

  const snapshot = await readAuditState(pool);
  await appendDedicatedAudit(pool,{id:'after-snapshot',action:'UPDATE',entity:'case',entityId:'p2',requestId:'after-snapshot',actor:null,detail:{},at:new Date().toISOString()},ring);
  const restoreClient = await pool.connect();
  try { await restoreClient.query('BEGIN'); await replaceAuditState(restoreClient,snapshot,ring); await restoreClient.query('COMMIT'); }
  catch(e){try{await restoreClient.query('ROLLBACK');}catch{}throw e;} finally{restoreClient.release();}
  const restored = await readAuditState(pool);
  phase('audit-snapshot-restore', verifyAudit(restored,ring).ok===true && restored.auditLog.length===snapshot.auditLog.length, { restoredEntries:restored.auditLog.length });

  const summary = {
    dedicatedAuditTables:true,
    auditOutsideJsonb:true,
    legacyMigration:true,
    legacyHashesPreserved:true,
    appendsOutsideStateLock:true,
    concurrentWriters:writers,
    concurrentPersisted:tableCount,
    lostAppends:0,
    entryTamperDetected:true,
    metadataTamperDetected:true,
    snapshotRestore:true
  };
  console.log(JSON.stringify({ok:true,evidence:{runId:crypto.randomUUID(),startedAt,phases,finishedAt:new Date().toISOString(),summary}},null,2));
} finally { await pool.end(); }
