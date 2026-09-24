import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadAuditKeyring } from './runtime/src/audit-integrity.mjs';
import { publicKeyringStatus } from './runtime/src/keyring.mjs';

const current = crypto.randomBytes(32).toString('base64url');
const historical = crypto.randomBytes(32).toString('base64url');
const value = JSON.stringify({
  activeKeyId: 'audit-current',
  legacyKeyId: 'audit-current',
  keys: { 'audit-current': current }
});

process.env.CJ_AUDIT_LEGACY_KEY_ID = 'audit-2026-09-prod';
const ring = loadAuditKeyring({ value, legacyValue: historical, production: true });
const status = publicKeyringStatus(ring);

assert.equal(status.activeKeyId, 'audit-current');
assert.equal(status.legacyKeyId, 'audit-current');
assert.deepEqual(status.knownKeyIds, ['audit-2026-09-prod','audit-current']);
assert.equal(ring.keys.get('audit-2026-09-prod').toString('base64url'), historical);
assert.equal(ring.keys.get('audit-current').toString('base64url'), current);

delete process.env.CJ_AUDIT_LEGACY_KEY_ID;
const noCompat = loadAuditKeyring({ value, legacyValue: historical, production: true });
assert.deepEqual(publicKeyringStatus(noCompat).knownKeyIds, ['audit-current']);

process.env.CJ_AUDIT_LEGACY_KEY_ID = 'invalid id with spaces';
assert.throws(
  () => loadAuditKeyring({ value, legacyValue: historical, production: true }),
  /CJ_AUDIT_LEGACY_KEY_ID inválido/
);

console.log('CJ_AUDIT_KEYRING_COMPAT_TEST=PASS');
