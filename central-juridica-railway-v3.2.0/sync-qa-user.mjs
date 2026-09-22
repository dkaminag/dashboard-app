import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { hashPassword, verifyPassword } from './runtime/src/auth.mjs';
import { appendAuditEntry, initializeAuditChain, loadAuditKeyring } from './runtime/src/audit-integrity.mjs';
import { persistAuditDelta, readAuditState } from './runtime/src/postgres-audit.mjs';

const databaseUrl = String(process.env.CJ_DATABASE_URL || '').trim();
const username = String(process.env.CJ_QA_USER || '').trim().toLowerCase();
const password = String(process.env.CJ_QA_PASSWORD || '');
if (!databaseUrl || !username || !password) throw new Error('QA_SYNC_CONFIG_MISSING');
if (!/^qa_[a-z0-9_.-]{3,80}$/.test(username)) throw new Error('QA_SYNC_USERNAME_NOT_SYNTHETIC');
if (password.length < 14 || password.length > 128) throw new Error('QA_SYNC_PASSWORD_POLICY_FAILED');

const require = createRequire(new URL('./runtime/package.json', import.meta.url));
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: databaseUrl,
  max: 2,
  connectionTimeoutMillis: Number(process.env.CJ_PG_CONNECT_TIMEOUT_MS || 5000),
  statement_timeout: Number(process.env.CJ_PG_STATEMENT_TIMEOUT_MS || 15000),
  application_name: 'central-juridica-qa-sync',
  ssl: process.env.CJ_PG_SSL === 'true' ? { rejectUnauthorized: true } : undefined
});
const auditKeyring = loadAuditKeyring();
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const selected = await client.query('SELECT payload FROM central_juridica_users WHERE username_normalized=$1 FOR UPDATE', [username]);
  let user = selected.rows?.[0]?.payload ? structuredClone(selected.rows[0].payload) : null;
  let changed = false;
  let created = false;
  if (!user) {
    const now = new Date().toISOString();
    user = {
      id: `usr_qa_${crypto.randomBytes(12).toString('hex')}`,
      username,
      name: 'QA Acceptance Synthetic',
      role: 'assistant',
      active: true,
      passwordHash: await hashPassword(password),
      createdAt: now,
      updatedAt: now
    };
    await client.query('INSERT INTO central_juridica_users(user_id,username_normalized,payload,updated_at) VALUES($1,$2,$3::jsonb,now())', [user.id, username, JSON.stringify(user)]);
    changed = true;
    created = true;
  } else {
    if (user.role !== 'assistant' || user.active !== true) throw new Error('QA_SYNC_ACCOUNT_POLICY_MISMATCH');
    if (String(user.username || '').toLowerCase() !== username) throw new Error('QA_SYNC_USERNAME_MISMATCH');
    const passwordMatches = await verifyPassword(password, user.passwordHash);
    if (!passwordMatches) {
      const now = new Date().toISOString();
      user.passwordHash = await hashPassword(password);
      user.passwordChangedAt = now;
      user.updatedAt = now;
      await client.query('UPDATE central_juridica_users SET payload=$2::jsonb,updated_at=now() WHERE user_id=$1', [user.id, JSON.stringify(user)]);
      await client.query('DELETE FROM central_juridica_sessions WHERE user_id=$1', [user.id]);
      changed = true;
    }
  }
  if (changed) {
    const current = await readAuditState(client, { forUpdate: true });
    if (!current.auditMeta?.initialized) initializeAuditChain(current, auditKeyring);
    const before = structuredClone(current);
    appendAuditEntry(current, {
      id: `audit_${crypto.randomUUID()}`,
      action: created ? 'QA_SYNTHETIC_USER_CREATED' : 'QA_SYNTHETIC_CREDENTIAL_SYNCED',
      entity: 'user',
      entityId: user.id,
      requestId: `predeploy_${crypto.randomUUID()}`,
      actor: null,
      detail: { username, synthetic: true, sessionsRevoked: created ? 0 : true },
      at: new Date().toISOString()
    }, auditKeyring);
    await persistAuditDelta(client, before, current, auditKeyring);
  }
  await client.query('COMMIT');
  console.log(JSON.stringify({ event: 'qa-synthetic-user-ready', username, changed, created }));
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  throw error;
} finally {
  client.release();
  await pool.end();
}
