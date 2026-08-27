import crypto from 'node:crypto';

const CHAIN_VERSION = 1;

export function loadAuditKey(value = process.env.CJ_AUDIT_KEY) {
  if (!value) throw new Error('CJ_AUDIT_KEY ausente.');
  const key = Buffer.from(String(value), 'base64url');
  if (key.length !== 32) throw new Error('CJ_AUDIT_KEY inválida.');
  return key;
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function payload(entry) {
  return {
    chainVersion: CHAIN_VERSION,
    id: entry.id,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    requestId: entry.requestId ?? null,
    actor: entry.actor ?? null,
    detail: entry.detail ?? {},
    at: entry.at,
    prevHash: entry.prevHash ?? null,
    baseline: Boolean(entry.baseline)
  };
}

export function computeAuditHash(entry, key) {
  return crypto.createHmac('sha256', key).update(canonical(payload(entry)), 'utf8').digest('hex');
}

export function initializeAuditChain(state, key, now = new Date().toISOString()) {
  if (state.auditMeta?.initialized && state.auditLog.every(e => e.chainVersion === CHAIN_VERSION && typeof e.hash === 'string')) return;
  let prevHash = null;
  const rebuilt = [];
  for (const original of state.auditLog.slice().reverse()) {
    const entry = { ...original, chainVersion: CHAIN_VERSION, prevHash, baseline: true };
    delete entry.hash;
    entry.hash = computeAuditHash(entry, key);
    prevHash = entry.hash;
    rebuilt.push(entry);
  }
  state.auditLog = rebuilt.reverse();
  state.auditMeta = { initialized: true, chainVersion: CHAIN_VERSION, initializedAt: now, baselineCount: state.auditLog.length, headHash: state.auditLog[0]?.hash || null, tailHash: state.auditLog.at(-1)?.prevHash || null, retainedCount: state.auditLog.length };
}

export function appendAuditEntry(state, fields, key) {
  initializeAuditChain(state, key);
  const entry = { ...fields, chainVersion: CHAIN_VERSION, prevHash: state.auditLog[0]?.hash || state.auditMeta.tailHash || null, baseline: false };
  entry.hash = computeAuditHash(entry, key);
  state.auditLog.unshift(entry);
  state.auditLog = state.auditLog.slice(0, 5000);
  state.auditMeta.headHash = state.auditLog[0]?.hash || null;
  state.auditMeta.tailHash = state.auditLog.at(-1)?.prevHash || null;
  state.auditMeta.retainedCount = state.auditLog.length;
  return entry;
}

export function verifyAuditChain(state, key) {
  const errors = [];
  const log = state.auditLog || [];
  const meta = state.auditMeta || {};
  if (!meta.initialized) errors.push('META_NOT_INITIALIZED');
  if (meta.retainedCount !== log.length) errors.push('COUNT_MISMATCH');
  for (let i = 0; i < log.length; i += 1) {
    const entry = log[i];
    const expectedPrev = i + 1 < log.length ? log[i + 1].hash : meta.tailHash || null;
    if ((entry.prevHash || null) !== expectedPrev) errors.push(`PREV_HASH_MISMATCH:${i}`);
    if (entry.hash !== computeAuditHash(entry, key)) errors.push(`HASH_MISMATCH:${i}`);
  }
  if ((meta.headHash || null) !== (log[0]?.hash || null)) errors.push('HEAD_HASH_MISMATCH');
  return { ok: errors.length === 0, errors };
}
