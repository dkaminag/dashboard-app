import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { PostgresStateStore } from '../src/postgres-store.mjs';
import { emptyState } from '../src/store.mjs';

if (!process.env.CJ_DATABASE_URL) {
  console.error(JSON.stringify({ ok: false, error: 'CJ_DATABASE_URL ausente' }));
  process.exit(2);
}

const startedAt = new Date().toISOString();
const runId = crypto.randomUUID();
const pool = new pg.Pool({
  connectionString: process.env.CJ_DATABASE_URL,
  max: 30,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 5000,
  statement_timeout: 15000,
  application_name: 'central-juridica-ci-gate'
});
const store = new PostgresStateStore(pool);
const evidence = { runId, startedAt, phases: [] };
const phase = (name, detail = {}) => evidence.phases.push({ name, ok: true, ...detail });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  const version = await pool.query('SELECT version() AS version');
  phase('postgres-connectivity', { version: version.rows[0].version });

  await store.ensure();
  await store.ping();
  await store.replaceState(emptyState());
  phase('adapter-ready', { documentBlobs: store.supportsDocumentBlobs === true });

  const docId = `doc_gate_${runId}`;
  const payload = crypto.randomBytes(4096);
  const storedSha256 = crypto.createHash('sha256').update(payload).digest('hex');
  await store.transaction(async tx => {
    await tx.putDocumentBlob(docId, payload, storedSha256);
    tx.state.documents.push({ id: docId, name: 'gate.bin', storageBackend: 'postgres', storedSha256 });
  });
  const blob = await store.readDocumentBlob(docId);
  assert.ok(blob, 'Blob documental não foi persistido.');
  assert.equal(blob.payload.equals(payload), true, 'Payload bytea divergiu após leitura.');
  assert.equal(blob.storedSha256, storedSha256, 'Hash armazenado divergiu.');
  assert.equal((await store.read()).documents.some(d => d.id === docId), true, 'Metadado documental não foi persistido.');
  phase('document-blob-atomic-write', { bytes: payload.length, sha256: storedSha256 });

  const rollbackDocId = `doc_rollback_${runId}`;
  const rollbackPayload = Buffer.from('must-not-persist');
  const rollbackSha = crypto.createHash('sha256').update(rollbackPayload).digest('hex');
  let documentRollbackCaught = false;
  try {
    await store.transaction(async tx => {
      await tx.putDocumentBlob(rollbackDocId, rollbackPayload, rollbackSha);
      tx.state.documents.push({ id: rollbackDocId, storageBackend: 'postgres', storedSha256: rollbackSha });
      throw new Error('forced-document-rollback-gate');
    });
  } catch (error) {
    documentRollbackCaught = error.message === 'forced-document-rollback-gate';
  }
  assert.equal(documentRollbackCaught, true, 'Falha documental forçada não propagou.');
  assert.equal(await store.readDocumentBlob(rollbackDocId), null, 'Rollback documental falhou: blob persistiu.');
  assert.equal((await store.read()).documents.some(d => d.id === rollbackDocId), false, 'Rollback documental falhou: metadado persistiu.');
  phase('document-blob-rollback');

  for (let round = 1; round <= 3; round += 1) {
    await store.replaceState(emptyState());
    const prefix = `cli_gate_${runId}_r${round}_`;
    const writers = Array.from({ length: 25 }, (_, i) => store.mutate(async db => {
      await sleep(5 + ((i * 7) % 25));
      db.clients.push({ id: `${prefix}${i}`, name: `Gate ${round}-${i}` });
    }));
    await Promise.all(writers);
    const state = await store.read();
    const ids = state.clients.filter(c => c.id.startsWith(prefix)).map(c => c.id);
    assert.equal(ids.length, 25, `Round ${round}: lost update (${ids.length}/25).`);
    assert.equal(new Set(ids).size, 25, `Round ${round}: IDs duplicados.`);
    phase(`concurrency-round-${round}`, { writers: 25, persisted: ids.length });
  }

  await store.replaceState(emptyState());
  let rollbackCaught = false;
  try {
    await store.mutate(db => {
      db.clients.push({ id: `rollback_${runId}`, name: 'must-not-persist' });
      throw new Error('forced-rollback-gate');
    });
  } catch (error) {
    rollbackCaught = error.message === 'forced-rollback-gate';
  }
  assert.equal(rollbackCaught, true, 'Falha forçada não propagou como esperado.');
  const afterRollback = await store.read();
  assert.equal(afterRollback.clients.some(c => c.id === `rollback_${runId}`), false, 'Rollback falhou: escrita persistiu.');
  phase('rollback-via-real-adapter');

  await store.ping();
  phase('post-concurrency-readiness');

  evidence.finishedAt = new Date().toISOString();
  evidence.summary = { rounds: 3, writersPerRound: 25, totalConcurrentMutations: 75, lostUpdates: 0, documentBlobAtomicWrite: true, documentBlobRollback: true };
  console.log(JSON.stringify({ ok: true, evidence }, null, 2));
} catch (error) {
  evidence.finishedAt = new Date().toISOString();
  console.error(JSON.stringify({ ok: false, evidence, error: { name: error.name, message: error.message, stack: error.stack } }, null, 2));
  process.exitCode = 1;
} finally {
  try { await pool.query('DELETE FROM central_juridica_document_blobs WHERE document_id LIKE $1', [`%${runId}%`]); } catch {}
  try { await store.replaceState(emptyState()); } catch {}
  await pool.end();
}
