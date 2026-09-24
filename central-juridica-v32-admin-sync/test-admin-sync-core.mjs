import assert from 'node:assert/strict';
import {
  applyPasswordUpdate,
  immutableFingerprint,
  validateAdminUser
} from './admin-sync-core.mjs';

const original = {
  id:'usr_admin_001',
  username:'admin@example.test',
  role:'admin',
  active:true,
  name:'Admin',
  passwordHash:'old-hash',
  passwordChangedAt:'2026-01-01T00:00:00.000Z',
  updatedAt:'2026-01-01T00:00:00.000Z',
  mfaEnabled:true,
  mfaSecret:'secret-must-stay',
  recoveryCodes:['a','b'],
  permissions:['admin'],
  profile:{theme:'system'}
};

validateAdminUser(original,'admin@example.test');
const before = immutableFingerprint(original);
const next = applyPasswordUpdate(original,'new-hash','2026-09-24T16:00:00.000Z');
const after = immutableFingerprint(next);

assert.equal(before, after);
assert.equal(next.passwordHash,'new-hash');
assert.equal(next.mfaEnabled,true);
assert.equal(next.mfaSecret,'secret-must-stay');
assert.deepEqual(next.recoveryCodes,['a','b']);
assert.deepEqual(next.permissions,['admin']);
assert.deepEqual(next.profile,{theme:'system'});

assert.throws(
  () => validateAdminUser({...original,role:'assistant'},'admin@example.test'),
  /ADMIN_SYNC_ROLE_MISMATCH/
);
assert.throws(
  () => validateAdminUser({...original,active:false},'admin@example.test'),
  /ADMIN_SYNC_ACCOUNT_INACTIVE/
);
assert.throws(
  () => validateAdminUser({...original,username:'other@example.test'},'admin@example.test'),
  /ADMIN_SYNC_USERNAME_MISMATCH/
);

console.log(JSON.stringify({
  event:'admin-sync-core-tests',
  passed:true,
  immutablePayloadPreserved:true,
  cases:4
}));
