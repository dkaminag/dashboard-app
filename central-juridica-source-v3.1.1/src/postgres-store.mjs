import crypto from 'node:crypto';
import { emptyState, normalizeState } from './store.mjs';
import { loadAuditKeyring } from './audit-integrity.mjs';
import { appendDedicatedAudit, ensureAuditTables, migrateLegacyAudit, persistAuditDelta, readAuditState, replaceAuditState } from './postgres-audit.mjs';
import { ensureUserTable, findUserById as findDedicatedUserById, findUserByUsername as findDedicatedUserByUsername, migrateLegacyUsers, readUsers, syncUsers } from './postgres-users.mjs';
import { appendAuditEntry } from './audit-integrity.mjs';
import { ensureTaskTable, readTasks, findTaskById as findDedicatedTaskById, insertTask, updateTask, migrateLegacyTasks } from './postgres-tasks.mjs';
import { ensureProcessTable, readProcesses, findProcessById as findDedicatedProcessById, insertProcess, updateProcess, migrateLegacyProcesses } from './postgres-processes.mjs';
import { ensureAgreementTable, readAgreements, findAgreementById as findDedicatedAgreementById, insertAgreement, updateAgreement, migrateLegacyAgreements } from './postgres-agreements.mjs';
import { ensureExecutionTable, readExecutionActions, findExecutionActionById as findDedicatedExecutionActionById, insertExecutionAction, updateExecutionAction, migrateLegacyExecutionActions } from './postgres-executions.mjs';
import { ensureFinancialEntryTable, readFinancialEntries, findFinancialEntryById as findDedicatedFinancialEntryById, insertFinancialEntry, updateFinancialEntry, migrateLegacyFinancialEntries } from './postgres-finance.mjs';
import { ensurePreventiveAssessmentTable, readPreventiveAssessments, findPreventiveAssessmentById as findDedicatedPreventiveAssessmentById, insertPreventiveAssessment, updatePreventiveAssessment, migrateLegacyPreventiveAssessments } from './postgres-preventive.mjs';
import { ensureExternalEvidenceTable, readExternalEvidence, findExternalEvidenceById as findDedicatedExternalEvidenceById, findExternalEvidenceByProviderExternalId as findDedicatedExternalEvidenceByProviderExternalId, insertExternalEvidence, updateExternalEvidence, migrateLegacyExternalEvidence } from './postgres-external-evidence.mjs';
import { ensureClientTable, readClients, findClientById as findDedicatedClientById, insertClient, migrateLegacyClients } from './postgres-clients.mjs';
import { ensureDocumentTables, readDocuments, findDocumentById as findDedicatedDocumentById, findDocumentByProcessHash as findDedicatedDocumentByProcessHash, insertDocumentIfAbsent, putBlob as putDedicatedBlob, migrateLegacyDocuments, validateDocumentSnapshot } from './postgres-documents.mjs';
import { acquireIdempotencyLock, clearExpiredIdempotency, ensureIdempotencyTable, loadIdempotencyKey, migrateLegacyIdempotency, readIdempotencyResult, storeIdempotencyResult } from './postgres-idempotency.mjs';

export const POSTGRES_STATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS central_juridica_state (
  singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO central_juridica_state(singleton, state)
VALUES (TRUE, $1::jsonb)
ON CONFLICT (singleton) DO NOTHING;
`;

export const POSTGRES_DOCUMENT_BLOB_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS central_juridica_document_blobs (
  document_id text PRIMARY KEY,
  payload bytea NOT NULL,
  stored_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

function assertHexSha256(value) {
  if (!/^[a-f0-9]{64}$/.test(String(value || ''))) throw new TypeError('SHA-256 armazenado inválido.');
}

function normalizeBlobRow(row) {
  const payload = Buffer.isBuffer(row.payload) ? row.payload : Buffer.from(row.payload || []);
  return { documentId: String(row.document_id || row.documentId || ''), payload, storedSha256: String(row.stored_sha256 || row.storedSha256 || '').trim() };
}

export class PostgresStateStore {
  constructor(pool) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('Pool PostgreSQL inválido.');
    this.pool = pool;
    this.supportsDocumentBlobs = true;
    this.supportsAtomicSnapshot = true;
    this.supportsDedicatedSessions = true;
    this.supportsDedicatedUsers = true;
    this.supportsDedicatedAudit = true;
    this.supportsDedicatedIdempotency = true;
    this.supportsDedicatedTasks = true;
    this.supportsDedicatedProcesses = true;
    this.supportsDedicatedAgreements = true;
    this.supportsDedicatedExecutionActions = true;
    this.supportsDedicatedFinancialEntries = true;
    this.supportsDedicatedPreventiveAssessments = true;
    this.supportsDedicatedExternalEvidence = true;
    this.supportsDedicatedClients = true;
    this.supportsDedicatedDocuments = true;
    this.auditKeyring = loadAuditKeyring();
    this.idempotencyKey = loadIdempotencyKey();
  }

  async ensure() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS central_juridica_state (
      singleton boolean PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
      state jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await this.pool.query(
      'INSERT INTO central_juridica_state(singleton, state) VALUES (TRUE, $1::jsonb) ON CONFLICT (singleton) DO NOTHING',
      [JSON.stringify(emptyState())]
    );
    await this.pool.query(`CREATE TABLE IF NOT EXISTS central_juridica_document_blobs (
      document_id text PRIMARY KEY,
      payload bytea NOT NULL,
      stored_sha256 char(64) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS central_juridica_sessions (
      token_hash char(64) PRIMARY KEY,
      session_id text NOT NULL UNIQUE,
      user_id text NOT NULL,
      created_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await this.pool.query('CREATE INDEX IF NOT EXISTS central_juridica_sessions_user_id_idx ON central_juridica_sessions(user_id)');
    await this.pool.query('CREATE INDEX IF NOT EXISTS central_juridica_sessions_expires_at_idx ON central_juridica_sessions(expires_at)');
    await ensureUserTable(this.pool);
    await migrateLegacyUsers(this.pool, normalizeState);
    await ensureAuditTables(this.pool);
    await migrateLegacyAudit(this.pool, normalizeState, this.auditKeyring);
    await ensureIdempotencyTable(this.pool);
    await migrateLegacyIdempotency(this.pool, normalizeState, this.idempotencyKey);
    await ensureTaskTable(this.pool);
    await migrateLegacyTasks(this.pool);
    await ensureProcessTable(this.pool);
    await migrateLegacyProcesses(this.pool);
    await ensureAgreementTable(this.pool);
    await migrateLegacyAgreements(this.pool);
    await ensureExecutionTable(this.pool);
    await migrateLegacyExecutionActions(this.pool);
    await ensureFinancialEntryTable(this.pool);
    await migrateLegacyFinancialEntries(this.pool);
    await ensurePreventiveAssessmentTable(this.pool);
    await migrateLegacyPreventiveAssessments(this.pool);
    await ensureExternalEvidenceTable(this.pool);
    await migrateLegacyExternalEvidence(this.pool);
    await ensureClientTable(this.pool);
    await migrateLegacyClients(this.pool);
    await ensureDocumentTables(this.pool);
    await migrateLegacyDocuments(this.pool);
  }


  async _readUsers(queryable = this.pool) { return readUsers(queryable); }
  async _syncUsers(queryable, users) { return syncUsers(queryable, users); }

  async read() {
    const result = await this.pool.query('SELECT state FROM central_juridica_state WHERE singleton = TRUE');
    if (!result.rows?.length) { await this.ensure(); return this.read(); }
    const db = normalizeState(result.rows[0].state);
    db.users = await this._readUsers();
    const audit = await readAuditState(this.pool);
    db.auditLog = audit.auditLog; db.auditMeta = audit.auditMeta;
    db.idempotency = {};
    db.tasks = await readTasks(this.pool);
    db.processes = await readProcesses(this.pool);
    db.agreements = await readAgreements(this.pool);
    db.executionActions = await readExecutionActions(this.pool);
    db.financialEntries = await readFinancialEntries(this.pool);
    db.preventiveAssessments = await readPreventiveAssessments(this.pool);
    db.externalEvidence = await readExternalEvidence(this.pool);
    db.clients = await readClients(this.pool);
    db.documents = await readDocuments(this.pool);
    return db;
  }

  async findUserById(userId) { return findDedicatedUserById(this.pool, userId); }

  async findUserByUsername(username) { return findDedicatedUserByUsername(this.pool, username); }

  async listUsers() { return this._readUsers(); }

  async _executeDomainTransaction(client, fn) {
    const selected = await client.query('SELECT state FROM central_juridica_state WHERE singleton = TRUE FOR UPDATE');
    if (!selected.rows?.length) throw new Error('Estado PostgreSQL não inicializado.');
    const db = normalizeState(selected.rows[0].state);
    db.idempotency = {};
    db.users = await this._readUsers(client);
    const auditBefore = await readAuditState(client, { forUpdate: true });
    db.auditLog = structuredClone(auditBefore.auditLog); db.auditMeta = structuredClone(auditBefore.auditMeta);
    const tx = {
      state: db,
      putDocumentBlob: async (documentId, payload, storedSha256) => {
        if (!documentId) throw new TypeError('documentId obrigatório.');
        if (!Buffer.isBuffer(payload)) throw new TypeError('Payload documental deve ser Buffer.');
        assertHexSha256(storedSha256);
        await client.query(
          `INSERT INTO central_juridica_document_blobs(document_id, payload, stored_sha256)
           VALUES($1,$2,$3)
           ON CONFLICT(document_id) DO UPDATE SET payload=excluded.payload, stored_sha256=excluded.stored_sha256, updated_at=now()`,
          [documentId, payload, storedSha256]
        );
      },
      deleteDocumentBlob: async documentId => client.query('DELETE FROM central_juridica_document_blobs WHERE document_id=$1', [documentId]),
      findSession: async tokenHash => {
        const result = await client.query('SELECT session_id, token_hash, user_id, created_at, expires_at FROM central_juridica_sessions WHERE token_hash=$1', [tokenHash]);
        if (!result.rows?.length) return db.sessions.find(s => s.tokenHash === tokenHash) || null;
        const row = result.rows[0];
        return { id: row.session_id, tokenHash: String(row.token_hash).trim(), userId: row.user_id, createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() };
      },
      createSession: async (record, { replaceUserSessions = true, now = Date.now() } = {}) => {
        const expired = await client.query('DELETE FROM central_juridica_sessions WHERE expires_at <= $1::timestamptz', [new Date(now).toISOString()]);
        let revoked = Number(expired.rowCount || 0);
        if (replaceUserSessions) {
          const removed = await client.query('DELETE FROM central_juridica_sessions WHERE user_id=$1', [record.userId]);
          revoked += Number(removed.rowCount || 0);
        }
        const legacyBefore = db.sessions.length;
        db.sessions = db.sessions.filter(s => Date.parse(s.expiresAt) > now && (!replaceUserSessions || s.userId !== record.userId) && s.tokenHash !== record.tokenHash);
        revoked += legacyBefore - db.sessions.length;
        await client.query(`INSERT INTO central_juridica_sessions(token_hash, session_id, user_id, created_at, expires_at, updated_at)
          VALUES($1,$2,$3,$4::timestamptz,$5::timestamptz,now())
          ON CONFLICT(token_hash) DO UPDATE SET session_id=excluded.session_id,user_id=excluded.user_id,created_at=excluded.created_at,expires_at=excluded.expires_at,updated_at=now()`,
          [record.tokenHash, record.id, record.userId, record.createdAt, record.expiresAt]);
        return { revoked };
      },
      revokeSession: async tokenHash => {
        const removed = await client.query('DELETE FROM central_juridica_sessions WHERE token_hash=$1', [tokenHash]);
        const before = db.sessions.length; db.sessions = db.sessions.filter(s => s.tokenHash !== tokenHash);
        return Number(removed.rowCount || 0) + (before - db.sessions.length);
      },
      revokeUserSessions: async userId => {
        const removed = await client.query('DELETE FROM central_juridica_sessions WHERE user_id=$1', [userId]);
        const before = db.sessions.length; db.sessions = db.sessions.filter(s => s.userId !== userId);
        return Number(removed.rowCount || 0) + (before - db.sessions.length);
      },
      clearAllSessions: async () => {
        const removed = await client.query('DELETE FROM central_juridica_sessions');
        const legacy = db.sessions.length; db.sessions = []; return Number(removed.rowCount || 0) + legacy;
      }
    };
    const output = await fn(tx);
    await this._syncUsers(client, db.users);
    await persistAuditDelta(client, auditBefore, db, this.auditKeyring);
    const persistedState = normalizeState(db);
    persistedState.users = [];
    persistedState.auditLog = []; persistedState.auditMeta = {};
    persistedState.idempotency = {};
    await client.query('UPDATE central_juridica_state SET state = $1::jsonb, updated_at = now() WHERE singleton = TRUE', [JSON.stringify(persistedState)]);
    return output;
  }

  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const output = await this._executeDomainTransaction(client, fn);
      await client.query('COMMIT');
      return output;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally { client.release(); }
  }

  async idempotentTransaction(scope, rawKey, fn, { ttlMs } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const lock = await acquireIdempotencyLock(client, scope, rawKey, this.idempotencyKey);
      const replay = await readIdempotencyResult(client, lock.scope, lock.keyHash);
      if (replay !== null) {
        await client.query('COMMIT');
        return { ...replay, replayed: true };
      }
      const output = await this._executeDomainTransaction(client, fn);
      await storeIdempotencyResult(client, lock.scope, lock.keyHash, output, { ttlMs });
      await client.query('COMMIT');
      return output;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally { client.release(); }
  }

  async listTasks() { return readTasks(this.pool); }
  async findTaskById(id) { return findDedicatedTaskById(this.pool,id); }

  async createDedicatedTask(task, auditFields) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); await insertTask(client, task); const before=await readAuditState(client,{forUpdate:true}); const after=structuredClone(before); appendAuditEntry(after,auditFields,this.auditKeyring); await persistAuditDelta(client,before,after,this.auditKeyring); await client.query('COMMIT'); return { task }; }
    catch(error){ try{await client.query('ROLLBACK')}catch{} throw error; } finally { client.release(); }
  }

  async idempotentTaskCreate(rawKey, task, auditFields, { ttlMs } = {}) {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      const lock=await acquireIdempotencyLock(client,'task',rawKey,this.idempotencyKey);
      const replay=await readIdempotencyResult(client,lock.scope,lock.keyHash);
      if(replay!==null){await client.query('COMMIT');return {...replay,replayed:true};}
      await insertTask(client,task);
      const before=await readAuditState(client,{forUpdate:true}); const after=structuredClone(before);
      appendAuditEntry(after,auditFields,this.auditKeyring); await persistAuditDelta(client,before,after,this.auditKeyring);
      const output={task}; await storeIdempotencyResult(client,lock.scope,lock.keyHash,output,{ttlMs});
      await client.query('COMMIT'); return output;
    } catch(e){try{await client.query('ROLLBACK')}catch{}throw e} finally{client.release()}
  }

  async updateDedicatedTask(task,auditFields){
    const client=await this.pool.connect(); try{await client.query('BEGIN'); await updateTask(client,task);
      const before=await readAuditState(client,{forUpdate:true}); const after=structuredClone(before); appendAuditEntry(after,auditFields,this.auditKeyring); await persistAuditDelta(client,before,after,this.auditKeyring);
      await client.query('COMMIT'); return task;
    }catch(e){try{await client.query('ROLLBACK')}catch{}throw e}finally{client.release()}
  }

  async listProcesses() { return readProcesses(this.pool); }
  async findProcessById(id) { return findDedicatedProcessById(this.pool, id); }

  async createDedicatedProcess(processRecord, auditFields) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); await insertProcess(client, processRecord); const before=await readAuditState(client,{forUpdate:true}); const after=structuredClone(before); appendAuditEntry(after,auditFields,this.auditKeyring); await persistAuditDelta(client,before,after,this.auditKeyring); await client.query('COMMIT'); return { process: processRecord }; }
    catch(error){ try{await client.query('ROLLBACK')}catch{} throw error; } finally { client.release(); }
  }

  async idempotentProcessCreate(rawKey, processRecord, auditFields, { ttlMs } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const lock=await acquireIdempotencyLock(client,'process',rawKey,this.idempotencyKey); const replay=await readIdempotencyResult(client,lock.scope,lock.keyHash);
      if(replay!==null){await client.query('COMMIT');return {...replay,replayed:true};}
      await insertProcess(client,processRecord); const before=await readAuditState(client,{forUpdate:true}); const after=structuredClone(before); appendAuditEntry(after,auditFields,this.auditKeyring); await persistAuditDelta(client,before,after,this.auditKeyring);
      const output={process:processRecord}; await storeIdempotencyResult(client,lock.scope,lock.keyHash,output,{ttlMs}); await client.query('COMMIT'); return output;
    } catch(error){try{await client.query('ROLLBACK')}catch{}throw error} finally{client.release()}
  }

  async updateDedicatedProcess(processRecord, auditFields) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); await updateProcess(client,processRecord); const before=await readAuditState(client,{forUpdate:true}); const after=structuredClone(before); appendAuditEntry(after,auditFields,this.auditKeyring); await persistAuditDelta(client,before,after,this.auditKeyring); await client.query('COMMIT'); return processRecord; }
    catch(error){try{await client.query('ROLLBACK')}catch{}throw error} finally{client.release()}
  }

  async listAgreements() { return readAgreements(this.pool); }
  async findAgreementById(id) { return findDedicatedAgreementById(this.pool, id); }

  async createDedicatedAgreement(agreement, auditFields) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); await insertAgreement(client, agreement); const before=await readAuditState(client,{forUpdate:true}); const after=structuredClone(before); appendAuditEntry(after,auditFields,this.auditKeyring); await persistAuditDelta(client,before,after,this.auditKeyring); await client.query('COMMIT'); return { agreement }; }
    catch(error){try{await client.query('ROLLBACK')}catch{}throw error} finally{client.release()}
  }

  async idempotentAgreementCreate(rawKey, agreement, auditFields, { ttlMs } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const lock=await acquireIdempotencyLock(client,'agreement',rawKey,this.idempotencyKey); const replay=await readIdempotencyResult(client,lock.scope,lock.keyHash);
      if(replay!==null){await client.query('COMMIT');return {...replay,replayed:true};}
      await insertAgreement(client,agreement); const before=await readAuditState(client,{forUpdate:true}); const after=structuredClone(before); appendAuditEntry(after,auditFields,this.auditKeyring); await persistAuditDelta(client,before,after,this.auditKeyring);
      const output={agreement}; await storeIdempotencyResult(client,lock.scope,lock.keyHash,output,{ttlMs}); await client.query('COMMIT'); return output;
    } catch(error){try{await client.query('ROLLBACK')}catch{}throw error} finally{client.release()}
  }

  async updateDedicatedAgreement(agreement, auditFields) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); await updateAgreement(client,agreement); const before=await readAuditState(client,{forUpdate:true}); const after=structuredClone(before); appendAuditEntry(after,auditFields,this.auditKeyring); await persistAuditDelta(client,before,after,this.auditKeyring); await client.query('COMMIT'); return agreement; }
    catch(error){try{await client.query('ROLLBACK')}catch{}throw error} finally{client.release()}
  }

  async listExecutionActions() { return readExecutionActions(this.pool); }
  async findExecutionActionById(id) { return findDedicatedExecutionActionById(this.pool, id); }

  async createDedicatedExecutionAction(action, auditFields) {
    const client=await this.pool.connect(); try{await client.query('BEGIN'); await insertExecutionAction(client,action); const before=await readAuditState(client,{forUpdate:true}),after=structuredClone(before); appendAuditEntry(after,auditFields,this.auditKeyring); await persistAuditDelta(client,before,after,this.auditKeyring); await client.query('COMMIT'); return {execution:action};}catch(e){try{await client.query('ROLLBACK')}catch{}throw e}finally{client.release()}
  }

  async idempotentExecutionActionCreate(rawKey, action, auditFields, { ttlMs } = {}) {
    const client=await this.pool.connect(); try{await client.query('BEGIN'); const lock=await acquireIdempotencyLock(client,'execution',rawKey,this.idempotencyKey),replay=await readIdempotencyResult(client,lock.scope,lock.keyHash); if(replay!==null){await client.query('COMMIT');return {...replay,replayed:true};} await insertExecutionAction(client,action); const before=await readAuditState(client,{forUpdate:true}),after=structuredClone(before); appendAuditEntry(after,auditFields,this.auditKeyring); await persistAuditDelta(client,before,after,this.auditKeyring); const output={execution:action}; await storeIdempotencyResult(client,lock.scope,lock.keyHash,output,{ttlMs}); await client.query('COMMIT'); return output;}catch(e){try{await client.query('ROLLBACK')}catch{}throw e}finally{client.release()}
  }

  async updateDedicatedExecutionAction(action, auditFields) {
    const client=await this.pool.connect(); try{await client.query('BEGIN'); await updateExecutionAction(client,action); const before=await readAuditState(client,{forUpdate:true}),after=structuredClone(before); appendAuditEntry(after,auditFields,this.auditKeyring); await persistAuditDelta(client,before,after,this.auditKeyring); await client.query('COMMIT'); return action;}catch(e){try{await client.query('ROLLBACK')}catch{}throw e}finally{client.release()}
  }

  async listFinancialEntries() { return readFinancialEntries(this.pool); }
  async findFinancialEntryById(id) { return findDedicatedFinancialEntryById(this.pool, id); }

  async createDedicatedFinancialEntry(entry, auditFields) {
    const client=await this.pool.connect(); try{await client.query('BEGIN'); await insertFinancialEntry(client,entry); const before=await readAuditState(client,{forUpdate:true}),after=structuredClone(before); appendAuditEntry(after,auditFields,this.auditKeyring); await persistAuditDelta(client,before,after,this.auditKeyring); await client.query('COMMIT'); return {entry};}catch(e){try{await client.query('ROLLBACK')}catch{}throw e}finally{client.release()}
  }

  async idempotentFinancialEntryCreate(rawKey, entry, auditFields, { ttlMs } = {}) {
    const client=await this.pool.connect(); try{await client.query('BEGIN'); const lock=await acquireIdempotencyLock(client,'finance',rawKey,this.idempotencyKey),replay=await readIdempotencyResult(client,lock.scope,lock.keyHash); if(replay!==null){await client.query('COMMIT');return {...replay,replayed:true};} await insertFinancialEntry(client,entry); const before=await readAuditState(client,{forUpdate:true}),after=structuredClone(before); appendAuditEntry(after,auditFields,this.auditKeyring); await persistAuditDelta(client,before,after,this.auditKeyring); const output={entry}; await storeIdempotencyResult(client,lock.scope,lock.keyHash,output,{ttlMs}); await client.query('COMMIT'); return output;}catch(e){try{await client.query('ROLLBACK')}catch{}throw e}finally{client.release()}
  }

  async updateDedicatedFinancialEntry(entry, auditFields) {
    const client=await this.pool.connect(); try{await client.query('BEGIN'); await updateFinancialEntry(client,entry); const before=await readAuditState(client,{forUpdate:true}),after=structuredClone(before); appendAuditEntry(after,auditFields,this.auditKeyring); await persistAuditDelta(client,before,after,this.auditKeyring); await client.query('COMMIT'); return entry;}catch(e){try{await client.query('ROLLBACK')}catch{}throw e}finally{client.release()}
  }

  async listPreventiveAssessments() { return readPreventiveAssessments(this.pool); }
  async findPreventiveAssessmentById(id) { return findDedicatedPreventiveAssessmentById(this.pool, id); }

  async createDedicatedPreventiveAssessment(assessment, auditFields) {
    const client=await this.pool.connect(); try{await client.query('BEGIN'); await insertPreventiveAssessment(client,assessment); const before=await readAuditState(client,{forUpdate:true}),after=structuredClone(before); appendAuditEntry(after,auditFields,this.auditKeyring); await persistAuditDelta(client,before,after,this.auditKeyring); await client.query('COMMIT'); return {assessment};}catch(e){try{await client.query('ROLLBACK')}catch{}throw e}finally{client.release()}
  }

  async idempotentPreventiveAssessmentCreate(rawKey, assessment, auditFields, { ttlMs } = {}) {
    const client=await this.pool.connect(); try{await client.query('BEGIN'); const lock=await acquireIdempotencyLock(client,'preventive',rawKey,this.idempotencyKey),replay=await readIdempotencyResult(client,lock.scope,lock.keyHash); if(replay!==null){await client.query('COMMIT');return {...replay,replayed:true};} await insertPreventiveAssessment(client,assessment); const before=await readAuditState(client,{forUpdate:true}),after=structuredClone(before); appendAuditEntry(after,auditFields,this.auditKeyring); await persistAuditDelta(client,before,after,this.auditKeyring); const output={assessment}; await storeIdempotencyResult(client,lock.scope,lock.keyHash,output,{ttlMs}); await client.query('COMMIT'); return output;}catch(e){try{await client.query('ROLLBACK')}catch{}throw e}finally{client.release()}
  }

  async updateDedicatedPreventiveAssessment(assessment, auditFields) {
    const client=await this.pool.connect(); try{await client.query('BEGIN'); await updatePreventiveAssessment(client,assessment); const before=await readAuditState(client,{forUpdate:true}),after=structuredClone(before); appendAuditEntry(after,auditFields,this.auditKeyring); await persistAuditDelta(client,before,after,this.auditKeyring); await client.query('COMMIT'); return assessment;}catch(e){try{await client.query('ROLLBACK')}catch{}throw e}finally{client.release()}
  }

  async listDocuments() { return readDocuments(this.pool); }
  async findDocumentById(id) { return findDedicatedDocumentById(this.pool,id); }
  async findDocumentByProcessHash(processId,hash) { return findDedicatedDocumentByProcessHash(this.pool,processId,hash); }
  async createDedicatedDocument(document,storedBytes,auditFields,rawKey=null,{ttlMs}={}){const client=await this.pool.connect();try{await client.query('BEGIN');let idem=null;if(rawKey){idem=await acquireIdempotencyLock(client,'document',rawKey,this.idempotencyKey);const replay=await readIdempotencyResult(client,idem.scope,idem.keyHash);if(replay!==null){await client.query('COMMIT');return{...replay,replayed:true};}}const inserted=await insertDocumentIfAbsent(client,document);let output;if(!inserted.inserted){output={document:inserted.document,duplicate:true};}else{await putDedicatedBlob(client,document.id,storedBytes,document.storedSha256);const before=await readAuditState(client,{forUpdate:true}),after=structuredClone(before);appendAuditEntry(after,auditFields,this.auditKeyring);await persistAuditDelta(client,before,after,this.auditKeyring);output={document};}if(idem)await storeIdempotencyResult(client,idem.scope,idem.keyHash,output,{ttlMs});await client.query('COMMIT');return output;}catch(e){try{await client.query('ROLLBACK')}catch{}throw e}finally{client.release()}}

  async listClients() { return readClients(this.pool); }
  async findClientById(id) { return findDedicatedClientById(this.pool,id); }
  async createDedicatedClient(clientRecord,auditFields){const client=await this.pool.connect();try{await client.query('BEGIN');await insertClient(client,clientRecord);const before=await readAuditState(client,{forUpdate:true}),after=structuredClone(before);appendAuditEntry(after,auditFields,this.auditKeyring);await persistAuditDelta(client,before,after,this.auditKeyring);await client.query('COMMIT');return{client:clientRecord};}catch(e){try{await client.query('ROLLBACK')}catch{}throw e}finally{client.release()}}
  async idempotentClientCreate(rawKey,clientRecord,auditFields,{ttlMs}={}){const client=await this.pool.connect();try{await client.query('BEGIN');const lock=await acquireIdempotencyLock(client,'client',rawKey,this.idempotencyKey),replay=await readIdempotencyResult(client,lock.scope,lock.keyHash);if(replay!==null){await client.query('COMMIT');return{...replay,replayed:true};}await insertClient(client,clientRecord);const before=await readAuditState(client,{forUpdate:true}),after=structuredClone(before);appendAuditEntry(after,auditFields,this.auditKeyring);await persistAuditDelta(client,before,after,this.auditKeyring);const output={client:clientRecord};await storeIdempotencyResult(client,lock.scope,lock.keyHash,output,{ttlMs});await client.query('COMMIT');return output;}catch(e){try{await client.query('ROLLBACK')}catch{}throw e}finally{client.release()}}

  async listExternalEvidence() { return readExternalEvidence(this.pool); }
  async findExternalEvidenceById(id) { return findDedicatedExternalEvidenceById(this.pool, id); }
  async findExternalEvidenceByProviderExternalId(provider, externalId) { return findDedicatedExternalEvidenceByProviderExternalId(this.pool, provider, externalId); }

  async createDedicatedExternalEvidence(evidence, auditFields) {
    const client=await this.pool.connect(); try{await client.query('BEGIN'); await insertExternalEvidence(client,evidence); const before=await readAuditState(client,{forUpdate:true}),after=structuredClone(before); appendAuditEntry(after,auditFields,this.auditKeyring); await persistAuditDelta(client,before,after,this.auditKeyring); await client.query('COMMIT'); return {item:evidence};}catch(e){try{await client.query('ROLLBACK')}catch{}throw e}finally{client.release()}
  }

  async idempotentExternalEvidenceCreate(rawKey, evidence, auditFields, { ttlMs } = {}) {
    const client=await this.pool.connect(); try{await client.query('BEGIN'); const lock=await acquireIdempotencyLock(client,'evidence',rawKey,this.idempotencyKey),replay=await readIdempotencyResult(client,lock.scope,lock.keyHash); if(replay!==null){await client.query('COMMIT');return {...replay,replayed:true};} await insertExternalEvidence(client,evidence); const before=await readAuditState(client,{forUpdate:true}),after=structuredClone(before); appendAuditEntry(after,auditFields,this.auditKeyring); await persistAuditDelta(client,before,after,this.auditKeyring); const output={item:evidence}; await storeIdempotencyResult(client,lock.scope,lock.keyHash,output,{ttlMs}); await client.query('COMMIT'); return output;}catch(e){try{await client.query('ROLLBACK')}catch{}throw e}finally{client.release()}
  }

  async reviewDedicatedExternalEvidence(id, makeNext, auditFactory) {
    const client=await this.pool.connect(); try{await client.query('BEGIN'); const current=await findDedicatedExternalEvidenceById(client,id,{forUpdate:true}); if(!current)throw Object.assign(new Error('Evidência externa não encontrada.'),{status:404}); if(current.status!=='Pendente')throw Object.assign(new Error('Evidência já revisada; a decisão é imutável para preservar a trilha de auditoria.'),{status:409}); const next=await makeNext(current); await updateExternalEvidence(client,next); const before=await readAuditState(client,{forUpdate:true}),after=structuredClone(before); appendAuditEntry(after,auditFactory(next),this.auditKeyring); await persistAuditDelta(client,before,after,this.auditKeyring); await client.query('COMMIT'); return next;}catch(e){try{await client.query('ROLLBACK')}catch{}throw e}finally{client.release()}
  }

  async clearExpiredIdempotency() { return clearExpiredIdempotency(this.pool); }

  async mutate(fn) { return this.transaction(({ state }) => fn(state)); }

  async findSession(tokenHash) {
    const result = await this.pool.query('SELECT session_id, token_hash, user_id, created_at, expires_at FROM central_juridica_sessions WHERE token_hash=$1', [tokenHash]);
    if (result.rows?.length) {
      const row = result.rows[0];
      return { id: row.session_id, tokenHash: String(row.token_hash).trim(), userId: row.user_id, createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() };
    }
    const db = await this.read();
    const legacy = db.sessions.find(s => s.tokenHash === tokenHash);
    if (!legacy) return null;
    if (Date.parse(legacy.expiresAt) <= Date.now()) { await this.revokeSession(tokenHash); return null; }
    await this.transaction(async tx => { const live = tx.state.sessions.find(s => s.tokenHash === tokenHash); if (live) await tx.createSession(live, { replaceUserSessions: false }); });
    return legacy;
  }

  async createSession(record, options) { return this.transaction(tx => tx.createSession(record, options)); }
  async revokeSession(tokenHash) { return this.transaction(tx => tx.revokeSession(tokenHash)); }
  async revokeUserSessions(userId) { return this.transaction(tx => tx.revokeUserSessions(userId)); }

  async readDocumentBlob(documentId) {
    const result = await this.pool.query('SELECT payload, stored_sha256 FROM central_juridica_document_blobs WHERE document_id=$1', [documentId]);
    if (!result.rows?.length) return null;
    const normalized = normalizeBlobRow({ ...result.rows[0], document_id: documentId });
    return { payload: normalized.payload, storedSha256: normalized.storedSha256 };
  }

  async exportSnapshot() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      // SHARE conflicts with the FOR UPDATE mutation lock and keeps state + blobs aligned during the snapshot.
      const stateResult = await client.query('SELECT state FROM central_juridica_state WHERE singleton = TRUE FOR SHARE');
      if (!stateResult.rows?.length) throw new Error('Estado PostgreSQL não inicializado.');
      const users = await this._readUsers(client);
      const blobResult = await client.query('SELECT document_id, payload, stored_sha256 FROM central_juridica_document_blobs ORDER BY document_id');
      const snapshotState = normalizeState(stateResult.rows[0].state);
      snapshotState.users = users;
      snapshotState.sessions = [];
      snapshotState.idempotency = {};
      snapshotState.tasks = await readTasks(client);
      snapshotState.processes = await readProcesses(client);
      snapshotState.agreements = await readAgreements(client);
      snapshotState.executionActions = await readExecutionActions(client);
      snapshotState.financialEntries = await readFinancialEntries(client);
      snapshotState.preventiveAssessments = await readPreventiveAssessments(client);
      snapshotState.externalEvidence = await readExternalEvidence(client);
      snapshotState.clients = await readClients(client);
      snapshotState.documents = await readDocuments(client);
      const audit = await readAuditState(client);
      snapshotState.auditLog = audit.auditLog; snapshotState.auditMeta = audit.auditMeta;
      const snapshot = {
        state: snapshotState,
        documents: (blobResult.rows || []).map(normalizeBlobRow)
      };
      await client.query('COMMIT');
      return snapshot;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally { client.release(); }
  }

  async restoreSnapshot(snapshot) {
    if (!snapshot || !snapshot.state || !Array.isArray(snapshot.documents)) throw new TypeError('Snapshot PostgreSQL inválido.');
    const normalizedState = normalizeState(snapshot.state);
    const restoredUsers = structuredClone(normalizedState.users);
    const restoredAudit = { auditLog: structuredClone(normalizedState.auditLog), auditMeta: structuredClone(normalizedState.auditMeta) };
    normalizedState.users = [];
    normalizedState.sessions = [];
    normalizedState.idempotency = {};
    const restoredTasks = structuredClone(normalizedState.tasks || []);
    normalizedState.tasks = [];
    const restoredProcesses = structuredClone(normalizedState.processes || []);
    normalizedState.processes = [];
    const restoredAgreements = structuredClone(normalizedState.agreements || []);
    normalizedState.agreements = [];
    const restoredExecutionActions = structuredClone(normalizedState.executionActions || []);
    normalizedState.executionActions = [];
    const restoredFinancialEntries = structuredClone(normalizedState.financialEntries || []);
    normalizedState.financialEntries = [];
    const restoredPreventiveAssessments = structuredClone(normalizedState.preventiveAssessments || []);
    normalizedState.preventiveAssessments = [];
    const restoredExternalEvidence = structuredClone(normalizedState.externalEvidence || []);
    normalizedState.externalEvidence = [];
    const restoredClients = structuredClone(normalizedState.clients || []);
    normalizedState.clients = [];
    const restoredDocumentsMetadata = structuredClone(normalizedState.documents || []);
    normalizedState.documents = [];
    validateDocumentSnapshot({metadata:restoredDocumentsMetadata,blobs:snapshot.documents});
    normalizedState.auditLog = []; normalizedState.auditMeta = {};
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT state FROM central_juridica_state WHERE singleton = TRUE FOR UPDATE');
      if (!current.rows?.length) throw new Error('Estado PostgreSQL não inicializado.');
      for (const document of snapshot.documents) {
        if (!document.documentId || !Buffer.isBuffer(document.payload)) throw new TypeError('Blob do snapshot inválido.');
        assertHexSha256(document.storedSha256);
        const actual = crypto.createHash('sha256').update(document.payload).digest('hex');
        if (actual !== document.storedSha256) throw new Error(`Hash divergente no snapshot: ${document.documentId}`);
      }
      await client.query('DELETE FROM central_juridica_document_blobs');
      await client.query('DELETE FROM central_juridica_sessions');
      await client.query('DELETE FROM central_juridica_idempotency');
      await client.query('DELETE FROM central_juridica_tasks');
      await client.query('DELETE FROM central_juridica_processes');
      await client.query('DELETE FROM central_juridica_agreements');
      await client.query('DELETE FROM central_juridica_execution_actions');
      await client.query('DELETE FROM central_juridica_financial_entries');
      await client.query('DELETE FROM central_juridica_preventive_assessments');
      await client.query('DELETE FROM central_juridica_external_evidence');
      await client.query('DELETE FROM central_juridica_clients');
      await client.query('DELETE FROM central_juridica_documents');
      await this._syncUsers(client, restoredUsers);
      await replaceAuditState(client, restoredAudit, this.auditKeyring);
      for (const task of restoredTasks) await insertTask(client,task);
      for (const processRecord of restoredProcesses) await insertProcess(client,processRecord);
      for (const agreement of restoredAgreements) await insertAgreement(client,agreement);
      for (const action of restoredExecutionActions) await insertExecutionAction(client,action);
      for (const entry of restoredFinancialEntries) await insertFinancialEntry(client,entry);
      for (const assessment of restoredPreventiveAssessments) await insertPreventiveAssessment(client,assessment);
      for (const evidence of restoredExternalEvidence) await insertExternalEvidence(client,evidence);
      for (const clientRecord of restoredClients) await insertClient(client,clientRecord);
      for (const documentRecord of restoredDocumentsMetadata) { const inserted=await insertDocumentIfAbsent(client,documentRecord); if(!inserted.inserted) throw new Error('RESTORE_DOCUMENT_CONFLICT'); }
      for (const document of snapshot.documents) {
        await client.query(
          'INSERT INTO central_juridica_document_blobs(document_id, payload, stored_sha256) VALUES($1,$2,$3)',
          [document.documentId, document.payload, document.storedSha256]
        );
      }
      await client.query('UPDATE central_juridica_state SET state = $1::jsonb, updated_at = now() WHERE singleton = TRUE', [JSON.stringify(normalizedState)]);
      await client.query('COMMIT');
      return { ok: true, restoredVersion: normalizedState.version, restoredDocuments: snapshot.documents.length, restoredUsers: restoredUsers.length, restoredAuditEntries: restoredAudit.auditLog.length, sessionsRevoked: true, restoredTasks: restoredTasks.length, restoredProcesses: restoredProcesses.length, restoredAgreements: restoredAgreements.length, restoredExecutionActions: restoredExecutionActions.length, restoredFinancialEntries: restoredFinancialEntries.length, restoredPreventiveAssessments: restoredPreventiveAssessments.length, restoredExternalEvidence: restoredExternalEvidence.length, restoredClients: restoredClients.length, restoredDocumentMetadata: restoredDocumentsMetadata.length };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally { client.release(); }
  }

  async ping() {
    const result = await this.pool.query('SELECT 1 AS ok');
    if (result.rows?.[0]?.ok !== 1) throw new Error('PostgreSQL respondeu de forma inesperada ao ping.');
    return { ok: true, backend: 'postgres' };
  }

  async replaceState(nextState) {
    const normalized = normalizeState(nextState);
    return this.mutate(db => {
      const auditLog = structuredClone(db.auditLog || []);
      const auditMeta = structuredClone(db.auditMeta || {});
      for (const key of Object.keys(db)) delete db[key];
      Object.assign(db, structuredClone(normalized), { auditLog, auditMeta });
      return normalizeState(db);
    });
  }

  async readAuditState() { return readAuditState(this.pool); }

  async appendAudit(action, entity, entityId, requestId, detail = {}, actor = null) {
    return appendDedicatedAudit(this.pool, {
      id: `audit_${crypto.randomUUID()}`, action, entity, entityId, requestId, actor, detail, at: new Date().toISOString()
    }, this.auditKeyring);
  }
}
