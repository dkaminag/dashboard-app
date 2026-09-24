import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { hashPassword, verifyPassword } from './runtime/src/auth.mjs';
import {
  appendAuditEntry,
  initializeAuditChain,
  loadAuditKeyring
} from './runtime/src/audit-integrity.mjs';
import {
  persistAuditDelta,
  readAuditState
} from './runtime/src/postgres-audit.mjs';
import {
  applyPasswordUpdate,
  immutableFingerprint,
  validateAdminUser
} from './admin-sync-core.mjs';

const TARGET_DATABASE = 'central_juridica_v32_prod_r3';
const mode = String(process.env.CJ_ADMIN_SYNC_MODE || 'dry-run').trim().toLowerCase();
const approval = String(process.env.CJ_ADMIN_SYNC_APPROVAL || '').trim();
const rawDatabaseUrl = String(process.env.CJ_DATABASE_URL || '').trim();
const username = String(process.env.CJ_ADMIN_USER || '').trim().toLowerCase();
const password = String(process.env.CJ_ADMIN_PASSWORD || '');

if (process.env.CJ_ENV !== 'production') throw new Error('ADMIN_SYNC_REQUIRES_PRODUCTION_ENV');
if (!['dry-run','apply'].includes(mode)) throw new Error('ADMIN_SYNC_MODE_INVALID');
if (!rawDatabaseUrl || !username || !password) throw new Error('ADMIN_SYNC_CONFIG_MISSING');
if (username.startsWith('qa_')) throw new Error('ADMIN_SYNC_QA_ACCOUNT_FORBIDDEN');
if (password.length < 14 || password.length > 128) throw new Error('ADMIN_SYNC_PASSWORD_POLICY_FAILED');
if (mode === 'apply' && approval !== 'ADMIN_RESYNC_APPROVED_20260924') {
  throw new Error('ADMIN_SYNC_EXPLICIT_APPROVAL_MISSING');
}

const dbUrl = new URL(rawDatabaseUrl);
dbUrl.pathname = '/' + TARGET_DATABASE;
if (process.env.CJ_PG_SSL === 'true') dbUrl.searchParams.set('sslmode','verify-full');

const require = createRequire(new URL('./runtime/package.json', import.meta.url));
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: dbUrl.toString(),
  max: 2,
  connectionTimeoutMillis: Number(process.env.CJ_PG_CONNECT_TIMEOUT_MS || 5000),
  statement_timeout: Number(process.env.CJ_PG_STATEMENT_TIMEOUT_MS || 15000),
  application_name: 'central-juridica-admin-sync',
  ssl: process.env.CJ_PG_SSL === 'true' ? { rejectUnauthorized: true } : undefined
});

const auditKeyring = loadAuditKeyring();
const client = await pool.connect();

try {
  await client.query('BEGIN');

  const identity = await client.query('SELECT current_database() AS db');
  const currentDatabase = String(identity.rows?.[0]?.db || '');
  if (currentDatabase !== TARGET_DATABASE) {
    throw new Error('ADMIN_SYNC_DATABASE_MISMATCH_' + currentDatabase);
  }

  const selected = await client.query(
    'SELECT payload FROM central_juridica_users WHERE username_normalized=$1 FOR UPDATE',
    [username]
  );
  const user = selected.rows?.[0]?.payload ? structuredClone(selected.rows[0].payload) : null;
  validateAdminUser(user, username);

  const sessions = await client.query(
    'SELECT COUNT(*)::int AS count FROM central_juridica_sessions WHERE user_id=$1',
    [user.id]
  );
  const activeSessions = Number(sessions.rows?.[0]?.count || 0);
  const passwordMatches = await verifyPassword(password, user.passwordHash);

  const beforeFingerprint = immutableFingerprint(user);

  if (mode === 'dry-run') {
    await client.query('ROLLBACK');
    console.log(JSON.stringify({
      event:'admin-credential-sync-dry-run',
      mode,
      database:TARGET_DATABASE,
      username,
      role:user.role,
      active:user.active === true,
      passwordMatches,
      wouldChangePassword:!passwordMatches,
      activeSessions,
      sessionsWouldRevoke:activeSessions,
      payloadInvariantScope:'all-except-passwordHash-passwordChangedAt-updatedAt',
      applyPerformed:false
    }));
  } else {
    const now = new Date().toISOString();
    let next = structuredClone(user);
    let passwordChanged = false;

    if (!passwordMatches) {
      next = applyPasswordUpdate(user, await hashPassword(password), now);
      passwordChanged = true;
      await client.query(
        'UPDATE central_juridica_users SET payload=$2::jsonb,updated_at=now() WHERE user_id=$1',
        [user.id, JSON.stringify(next)]
      );
    }

    const afterFingerprint = immutableFingerprint(next);
    if (afterFingerprint !== beforeFingerprint) {
      throw new Error('ADMIN_SYNC_NON_CREDENTIAL_PAYLOAD_CHANGED');
    }

    const deletedSessions = await client.query(
      'DELETE FROM central_juridica_sessions WHERE user_id=$1 RETURNING session_id',
      [user.id]
    );

    const current = await readAuditState(client, { forUpdate: true });
    if (!current.auditMeta?.initialized) initializeAuditChain(current, auditKeyring);
    const auditBefore = structuredClone(current);

    appendAuditEntry(current, {
      id: 'audit_' + crypto.randomUUID(),
      action: 'ADMIN_CREDENTIAL_SYNCED',
      entity: 'user',
      entityId: user.id,
      requestId: 'admin_sync_' + crypto.randomUUID(),
      actor: null,
      detail: {
        username,
        passwordChanged,
        sessionsRevoked: deletedSessions.rowCount,
        mfaAndProfilePreserved: true
      },
      at: now
    }, auditKeyring);

    await persistAuditDelta(client, auditBefore, current, auditKeyring);
    await client.query('COMMIT');

    console.log(JSON.stringify({
      event:'admin-credential-sync-applied',
      mode,
      database:TARGET_DATABASE,
      username,
      passwordChanged,
      sessionsRevoked:deletedSessions.rowCount,
      mfaAndProfilePreserved:true,
      applyPerformed:true
    }));
  }
} catch (error) {
  try { await client.query('ROLLBACK'); } catch {}
  throw error;
} finally {
  client.release();
  await pool.end();
}
