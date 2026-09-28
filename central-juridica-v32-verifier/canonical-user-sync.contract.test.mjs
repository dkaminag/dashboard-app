import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./canonical-user-sync.mjs', import.meta.url), 'utf8');

const required = [
  "BEGIN READ ONLY",
  "CANONICAL_USER_SYNC_SOURCE_SESSION_ACTIVE",
  "CANONICAL_USER_SYNC_TARGET_CONFLICT",
  "CANONICAL_USER_SYNC_TARGET_ORPHAN_SESSION",
  "CANONICAL_USER_SYNC_CREDENTIAL_HASH_MISMATCH",
  "CANONICAL_USER_SYNC_MFA_STATE_MISMATCH",
  "CANONICAL_USER_MIGRATED",
  "credentialHashPreserved:true",
  "mfaStatePreserved:true",
  "sessionsMigrated:false",
  "await targetClient.query('BEGIN')",
  "await targetClient.query('COMMIT')",
  "await targetClient.query('ROLLBACK')"
];

for (const token of required) {
  assert.ok(source.includes(token), 'missing_guard:' + token);
}

const forbidden = [
  'console.log(sourceRow',
  'console.log(targetRow',
  'console.log(payload',
  'console.log(JSON.stringify(sourceRow',
  'console.log(JSON.stringify(targetRow',
  'console.log(JSON.stringify(payload'
];

for (const token of forbidden) {
  assert.equal(source.includes(token), false, 'sensitive_log_pattern:' + token);
}

assert.ok(source.includes("username === 'admin' || username.startsWith('qa_')"), 'protected_account_guard_missing');
assert.ok(source.includes("payload.role!=='lawyer'"), 'role_allowlist_missing');
assert.ok(source.includes("payload.active!==true"), 'active_guard_missing');

console.log('CANONICAL_USER_SYNC_CONTRACT=PASS');
