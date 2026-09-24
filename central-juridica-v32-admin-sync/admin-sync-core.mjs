import crypto from 'node:crypto';

const MUTABLE_CREDENTIAL_FIELDS = new Set([
  'passwordHash',
  'passwordChangedAt',
  'updatedAt',
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalize(value[key])])
    );
  }
  return value;
}

export function immutableProjection(user) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) {
    throw new Error('ADMIN_SYNC_USER_PAYLOAD_INVALID');
  }
  const clone = structuredClone(user);
  for (const key of MUTABLE_CREDENTIAL_FIELDS) delete clone[key];
  return canonicalize(clone);
}

export function immutableFingerprint(user) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(immutableProjection(user)))
    .digest('hex');
}

export function validateAdminUser(user, expectedUsername) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) {
    throw new Error('ADMIN_SYNC_USER_NOT_FOUND');
  }
  if (user.role !== 'admin') throw new Error('ADMIN_SYNC_ROLE_MISMATCH');
  if (user.active !== true) throw new Error('ADMIN_SYNC_ACCOUNT_INACTIVE');
  if (String(user.username || '').trim().toLowerCase() !== expectedUsername) {
    throw new Error('ADMIN_SYNC_USERNAME_MISMATCH');
  }
  if (!String(user.id || '').trim()) throw new Error('ADMIN_SYNC_USER_ID_MISSING');
  if (!String(user.passwordHash || '').trim()) throw new Error('ADMIN_SYNC_PASSWORD_HASH_MISSING');
  return true;
}

export function applyPasswordUpdate(user, passwordHash, now) {
  const next = structuredClone(user);
  next.passwordHash = passwordHash;
  next.passwordChangedAt = now;
  next.updatedAt = now;
  return next;
}
