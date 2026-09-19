import crypto from 'node:crypto';
import { activeKey, makeSingleKeyring, parseKeyring, resolveKey } from './keyring.mjs';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function loadMfaKey(value = process.env.CJ_MFA_KEY, { production = process.env.CJ_ENV === 'production' } = {}) {
  if (!value) {
    if (production) throw new Error('Modo production exige CJ_MFA_KEY para proteção dos segredos MFA.');
    return crypto.createHash('sha256').update('central-juridica-development-mfa-key-v1').digest();
  }
  const key = Buffer.from(String(value), 'base64url');
  if (key.length !== 32) throw new Error('CJ_MFA_KEY deve ser uma chave base64url de exatamente 32 bytes.');
  return key;
}

export function loadMfaKeyring({ value = process.env.CJ_MFA_KEYRING, legacyValue = process.env.CJ_MFA_KEY, production = process.env.CJ_ENV === 'production' } = {}) {
  return parseKeyring({ value, legacyValue, envName: 'CJ_MFA_KEYRING', legacyEnvName: 'CJ_MFA_KEY', production, devSeed: 'central-juridica-development-mfa-key-v1', defaultKeyId: 'mfa-legacy-v1' });
}

function asRing(keyOrRing) {
  if (Buffer.isBuffer(keyOrRing)) return makeSingleKeyring(keyOrRing, { keyId: 'mfa-legacy-v1', source: 'compat-buffer' });
  return keyOrRing;
}

export function generateTotpSecret() { return base32Encode(crypto.randomBytes(20)); }

export function makeOtpAuthUri({ secret, username, issuer = 'Central Juridica' }) {
  const label = `${issuer}:${username}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export function totpCode(secret, { time = Date.now(), step = 30, digits = 6 } = {}) {
  const key = base32Decode(secret); const counter = Math.floor(time / 1000 / step); const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(msg).digest(); const offset = digest[digest.length - 1] & 0x0f;
  const bin = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(bin % (10 ** digits)).padStart(digits, '0');
}

export function verifyTotp(secret, code, { time = Date.now(), window = 1 } = {}) {
  const supplied = String(code || '').trim(); if (!/^\d{6}$/.test(supplied)) return false;
  for (let delta = -window; delta <= window; delta += 1) {
    const expected = totpCode(secret, { time: time + delta * 30_000 });
    if (crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return true;
  }
  return false;
}

export function sealMfaSecret(secret, keyOrRing) {
  if (Buffer.isBuffer(keyOrRing)) {
    const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', keyOrRing, iv);
    const ciphertext = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
    return { v: 1, alg: 'A256GCM', iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: ciphertext.toString('base64url') };
  }
  const ring = asRing(keyOrRing); const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', activeKey(ring), iv);
  const aad = Buffer.from(`central-juridica-mfa-v2|${ring.activeKeyId}`); cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  return { v: 2, alg: 'A256GCM', keyId: ring.activeKeyId, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: ciphertext.toString('base64url') };
}

export function openMfaSecret(sealed, keyOrRing) {
  const ring = asRing(keyOrRing);
  if (!sealed || ![1,2].includes(sealed.v) || sealed.alg !== 'A256GCM') throw new Error('Segredo MFA selado inválido.');
  const keyId = sealed.v === 2 ? sealed.keyId : null;
  const { key } = resolveKey(ring, keyId, { allowLegacyFallback: sealed.v === 1 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64url'));
  if (sealed.v === 2) decipher.setAAD(Buffer.from(`central-juridica-mfa-v2|${sealed.keyId}`));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64url')), decipher.final()]).toString('utf8');
}

export function generateRecoveryCodes(count = 8) { return Array.from({ length: count }, () => `${randomGroup()}-${randomGroup()}`); }

export function hashRecoveryCode(code, keyOrRing) {
  if (Buffer.isBuffer(keyOrRing)) return crypto.createHmac('sha256', keyOrRing).update(normalizeRecoveryCode(code), 'utf8').digest('hex');
  const ring = asRing(keyOrRing);
  return { keyId: ring.activeKeyId, hash: crypto.createHmac('sha256', activeKey(ring)).update(normalizeRecoveryCode(code), 'utf8').digest('hex') };
}

export function consumeRecoveryCode(mfa, code, keyOrRing) {
  const ring = asRing(keyOrRing); const hashes = Array.isArray(mfa?.recoveryCodeHashes) ? mfa.recoveryCodeHashes : [];
  let found = -1;
  for (let i = 0; i < hashes.length; i += 1) {
    const candidate = hashes[i];
    if (typeof candidate === 'string') {
      const { key } = resolveKey(ring, null, { allowLegacyFallback: true });
      const expected = crypto.createHmac('sha256', key).update(normalizeRecoveryCode(code), 'utf8').digest('hex');
      if (safeHexEqual(candidate, expected)) { found = i; break; }
    } else if (candidate?.keyId && candidate?.hash) {
      let key; try { key = resolveKey(ring, candidate.keyId).key; } catch { continue; }
      const expected = crypto.createHmac('sha256', key).update(normalizeRecoveryCode(code), 'utf8').digest('hex');
      if (safeHexEqual(candidate.hash, expected)) { found = i; break; }
    }
  }
  if (found < 0) return false;
  hashes.splice(found, 1); mfa.recoveryCodeHashes = hashes; mfa.recoveryCodesRemaining = hashes.length; return true;
}

export function requiredMfaRoles({ production = process.env.CJ_ENV === 'production', value = process.env.CJ_MFA_REQUIRED_ROLES } = {}) {
  const raw = value ?? (production ? 'admin,lawyer' : ''); return new Set(String(raw).split(',').map(x => x.trim()).filter(Boolean));
}
export function isMfaRequired(role, options) { return requiredMfaRoles(options).has(String(role)); }

function normalizeRecoveryCode(code) { return String(code || '').trim().toUpperCase().replace(/\s+/g, ''); }
function randomGroup() { return crypto.randomBytes(5).toString('hex').toUpperCase(); }
function safeHexEqual(a, b) { if (!/^[a-f0-9]{64}$/i.test(String(a || '')) || !/^[a-f0-9]{64}$/i.test(String(b || ''))) return false; return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
function base32Encode(buffer) { let bits = 0, value = 0, output = ''; for (const byte of buffer) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { output += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) output += BASE32[(value << (5 - bits)) & 31]; return output; }
function base32Decode(text) { const clean = String(text || '').toUpperCase().replace(/=+$/,'').replace(/\s+/g,''); let bits = 0, value = 0; const out = []; for (const ch of clean) { const idx = BASE32.indexOf(ch); if (idx < 0) throw new Error('Segredo base32 inválido.'); value = (value << 5) | idx; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
