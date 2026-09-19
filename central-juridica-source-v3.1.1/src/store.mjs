import fs from 'node:fs/promises';
import path from 'node:path';
import { newId } from './domain.mjs';
import { appendAuditEntry, loadAuditKeyring } from './audit-integrity.mjs';

export function emptyState() {
  return { version: 9, auditMeta: {}, users: [], sessions: [], clients: [], processes: [], tasks: [], documents: [], agreements: [], executionActions: [], financialEntries: [], preventiveAssessments: [], externalEvidence: [], auditLog: [], idempotency: {} };
}

export function normalizeState(parsed = {}) {
  return {
    version: 9,
    auditMeta: parsed.auditMeta && typeof parsed.auditMeta === 'object' ? parsed.auditMeta : {},
    users: Array.isArray(parsed.users) ? parsed.users : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    clients: Array.isArray(parsed.clients) ? parsed.clients : [],
    processes: Array.isArray(parsed.processes) ? parsed.processes : [],
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    documents: Array.isArray(parsed.documents) ? parsed.documents : [],
    agreements: Array.isArray(parsed.agreements) ? parsed.agreements : [],
    executionActions: Array.isArray(parsed.executionActions) ? parsed.executionActions : [],
    financialEntries: Array.isArray(parsed.financialEntries) ? parsed.financialEntries : [],
    preventiveAssessments: Array.isArray(parsed.preventiveAssessments) ? parsed.preventiveAssessments : [],
    externalEvidence: Array.isArray(parsed.externalEvidence) ? parsed.externalEvidence : [],
    auditLog: Array.isArray(parsed.auditLog) ? parsed.auditLog : [],
    idempotency: parsed.idempotency && typeof parsed.idempotency === 'object' ? parsed.idempotency : {}
  };
}

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.writeChain = Promise.resolve();
  }

  async ensure() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
      const current = await this.readRaw();
      if ((current.version || 1) < 9) await this._write(normalizeState(current));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this._write(emptyState());
    }
  }

  async readRaw() {
    const raw = await fs.readFile(this.filePath, 'utf8');
    return JSON.parse(raw);
  }

  async read() {
    try {
      return normalizeState(await this.readRaw());
    } catch (error) {
      if (error.code === 'ENOENT') { await this.ensure(); return normalizeState(await this.readRaw()); }
      throw error;
    }
  }

  async mutate(fn) {
    const operation = this.writeChain.then(async () => {
      const db = await this.read();
      const result = await fn(db);
      await this._write(db);
      return result;
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }


  async transaction(fn) {
    return this.mutate(async state => {
      const tx = {
        state,
        findSession: async tokenHash => state.sessions.find(s => s.tokenHash === tokenHash) || null,
        createSession: async (record, { replaceUserSessions = true, now = Date.now() } = {}) => {
          const before = state.sessions.length;
          state.sessions = state.sessions.filter(s => Date.parse(s.expiresAt) > now && (!replaceUserSessions || s.userId !== record.userId) && s.tokenHash !== record.tokenHash);
          const revoked = before - state.sessions.length;
          state.sessions.push(structuredClone(record));
          return { revoked };
        },
        revokeSession: async tokenHash => {
          const before = state.sessions.length; state.sessions = state.sessions.filter(s => s.tokenHash !== tokenHash); return before - state.sessions.length;
        },
        revokeUserSessions: async userId => {
          const before = state.sessions.length; state.sessions = state.sessions.filter(s => s.userId !== userId); return before - state.sessions.length;
        },
        clearAllSessions: async () => { const count = state.sessions.length; state.sessions = []; return count; }
      };
      return fn(tx);
    });
  }

  async findSession(tokenHash) { const db = await this.read(); return db.sessions.find(s => s.tokenHash === tokenHash) || null; }
  async findUserById(userId) { const db = await this.read(); return db.users.find(u => u.id === userId) || null; }
  async findUserByUsername(username) { const db = await this.read(); return db.users.find(u => String(u.username).toLowerCase() === String(username || '').toLowerCase()) || null; }
  async listUsers() { const db = await this.read(); return db.users; }
  async createSession(record, options) { return this.transaction(tx => tx.createSession(record, options)); }
  async revokeSession(tokenHash) { return this.transaction(tx => tx.revokeSession(tokenHash)); }
  async revokeUserSessions(userId) { return this.transaction(tx => tx.revokeUserSessions(userId)); }

  async _write(db) {
    const tmp = `${this.filePath}.tmp`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(normalizeState(db), null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }

  async ping() {
    await this.read();
    return { ok: true, backend: 'json' };
  }

  async replaceState(nextState) {
    const normalized = normalizeState(nextState);
    return this.mutate(db => {
      for (const key of Object.keys(db)) delete db[key];
      Object.assign(db, structuredClone(normalized));
      return normalizeState(db);
    });
  }

  async appendAudit(action, entity, entityId, requestId, detail = {}, actor = null) {
    const keyring = loadAuditKeyring();
    return this.mutate(db => appendAuditEntry(db, { id: newId('audit'), action, entity, entityId, requestId, actor, detail, at: new Date().toISOString() }, keyring));
  }
}
