import crypto from 'node:crypto';

export const ROLES = ['admin', 'lawyer', 'assistant', 'auditor'];

export const ROLE_PERMISSIONS = Object.freeze({
  admin: ['*'],
  lawyer: [
    'dashboard:read', 'clients:read', 'clients:write', 'processes:read', 'processes:write',
    'tasks:read', 'tasks:write', 'documents:read', 'documents:write', 'processes:audit', 'audit:read', 'agreements:read', 'agreements:write', 'executions:read', 'executions:write', 'finance:read', 'finance:write', 'preventive:read', 'preventive:write', 'evidence:read', 'evidence:ingest', 'evidence:review', 'reports:read', 'integrations:read', 'integrations:sync', 'ai:draft', 'users:self'
  ],
  assistant: [
    'dashboard:read', 'clients:read', 'clients:write', 'processes:read', 'processes:write',
    'tasks:read', 'tasks:write', 'documents:read', 'documents:write', 'preventive:read', 'preventive:write', 'evidence:read', 'evidence:ingest', 'agreements:read', 'executions:read', 'executions:write', 'reports:read', 'integrations:read', 'users:self'
  ],
  auditor: [
    'dashboard:read', 'clients:read', 'processes:read', 'tasks:read', 'documents:read',
    'processes:audit', 'audit:read', 'preventive:read', 'evidence:read', 'agreements:read', 'executions:read', 'finance:read', 'reports:read', 'integrations:read', 'users:self'
  ]
});

export function hasPermission(role, permission) {
  const permissions = ROLE_PERMISSIONS[role] || [];
  return permissions.includes('*') || permissions.includes(permission);
}

export function validateRole(role) {
  return ROLES.includes(role) ? role : null;
}


export function validateNewPassword(password, { username = '', currentPassword = null } = {}) {
  const value = String(password || '');
  if (value.length < 14) return { ok: false, error: 'A nova senha deve possuir ao menos 14 caracteres.' };
  if (value.length > 128) return { ok: false, error: 'A senha excede 128 caracteres.' };
  if (username && value.toLowerCase().includes(String(username).toLowerCase())) return { ok: false, error: 'A senha não pode conter o nome de usuário.' };
  if (currentPassword !== null && value === String(currentPassword)) return { ok: false, error: 'A nova senha deve ser diferente da senha atual.' };
  const normalized = value.toLowerCase();
  const blocked = new Set(['12345678901234','passwordpassword','senha123456789','administrador123','qwertyuiopasdf']);
  if (blocked.has(normalized)) return { ok: false, error: 'Senha muito previsível.' };
  return { ok: true, value };
}

export async function hashPassword(password) {
  const value = String(password || '');
  if (value.length < 12) throw Object.assign(new Error('A senha deve possuir ao menos 12 caracteres.'), { status: 400 });
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(value, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password, encoded) {
  const [algo, saltText, hashText] = String(encoded || '').split('$');
  if (algo !== 'scrypt' || !saltText || !hashText) return false;
  try {
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(hashText, 'base64url');
    const actual = await scrypt(String(password || ''), salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function scrypt(password, salt, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derivedKey) => {
      if (error) reject(error); else resolve(derivedKey);
    });
  });
}
