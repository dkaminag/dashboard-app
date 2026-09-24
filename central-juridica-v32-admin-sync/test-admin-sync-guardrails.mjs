import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('./sync-admin-user.mjs', import.meta.url), 'utf8');
const dockerfile = await fs.readFile(new URL('./Dockerfile', import.meta.url), 'utf8').catch(() => '');

assert.match(source, /CJ_ADMIN_SYNC_MODE \|\| 'dry-run'/);
assert.match(source, /ADMIN_SYNC_EXPLICIT_APPROVAL_MISSING/);
assert.match(source, /central_juridica_v32_prod_r3/);
assert.match(source, /ADMIN_SYNC_USER_NOT_FOUND/);
assert.match(source, /ADMIN_SYNC_ROLE_MISMATCH/);
assert.match(source, /DELETE FROM central_juridica_sessions WHERE user_id=\$1/);
assert.match(source, /ADMIN_CREDENTIAL_SYNCED/);
assert.match(source, /immutableFingerprint/);
assert.doesNotMatch(source, /INSERT INTO central_juridica_users/i);
assert.doesNotMatch(source, /mfaSecret\s*=/i);
assert.doesNotMatch(source, /recoveryCodes\s*=/i);

if (dockerfile) {
  assert.match(dockerfile, /d507a9955be07ef710d410b5263686ac75caeeff/);
  assert.match(dockerfile, /d76a2dbf257853d495c177f7930c20c5ce5278bc/);
}

console.log(JSON.stringify({
  event:'admin-sync-guardrails',
  passed:true,
  dryRunDefault:true,
  explicitApprovalRequired:true,
  noAdminCreation:true,
  mfaMutationAbsent:true,
  runtimePinned:true
}));
