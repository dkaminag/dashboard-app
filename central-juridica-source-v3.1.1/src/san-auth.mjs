import crypto from 'node:crypto';

export function sanConfig(env = process.env) {
  const enabled = String(env.CJ_SAN_ENABLED || 'false').trim().toLowerCase() === 'true';
  const token = String(env.CJ_SAN_TOKEN || '').trim();
  const baseUrl = String(env.CJ_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  const production = String(env.CJ_ENV || '').trim().toLowerCase() === 'production';
  if (production && enabled && token.length < 32) throw new Error('CJ_SAN_ENABLED=true em production exige CJ_SAN_TOKEN com pelo menos 32 caracteres.');
  if (production && enabled && !/^https:\/\//i.test(baseUrl)) throw new Error('CJ_SAN_ENABLED=true em production exige CJ_PUBLIC_BASE_URL HTTPS explícita.');
  return { enabled, token, baseUrl };
}

export function extractBearer(req) {
  const raw = String(req?.headers?.authorization || '');
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

export function timingSafeTokenEqual(expected, provided) {
  const a = Buffer.from(String(expected || ''), 'utf8');
  const b = Buffer.from(String(provided || ''), 'utf8');
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function requireSanService(req, config) {
  if (!config?.enabled) throw Object.assign(new Error('SAN integration disabled.'), { status: 404, code: 'SAN_DISABLED' });
  const provided = extractBearer(req);
  if (!timingSafeTokenEqual(config.token, provided)) throw Object.assign(new Error('SAN service authentication failed.'), { status: 401, code: 'SAN_UNAUTHORIZED' });
  return { id: 'san-control-plane', role: 'service', scope: 'read-only' };
}

export const SAN_ALLOWED_ACTIONS = Object.freeze([
  'status:read',
  'gates:read'
]);

export const SAN_FORBIDDEN_ACTIONS = Object.freeze([
  'clients:write','processes:write','tasks:write','agreements:write','execution:write',
  'finance:write','preventive:write','documents:write','users:write','ai:invoke',
  'google:sync','backup:run','restore:run','session:revoke','audit:mutate'
]);
