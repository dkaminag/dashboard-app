import crypto from 'node:crypto';
import { activeKey, makeSingleKeyring, parseKeyring, resolveKey } from './keyring.mjs';

const MAGIC_V1 = Buffer.from('CJENC1');
const MAGIC_V2 = Buffer.from('CJENC2');

export function loadEncryptionKey(value = process.env.CJ_DOCUMENT_KEY) {
  if (!value) return null;
  let key;
  try { key = Buffer.from(String(value), 'base64url'); } catch { key = null; }
  if (!key || key.length !== 32) throw new Error('CJ_DOCUMENT_KEY deve ser uma chave base64url de exatamente 32 bytes.');
  return key;
}

export function loadDocumentKeyring({ value = process.env.CJ_DOCUMENT_KEYRING, legacyValue = process.env.CJ_DOCUMENT_KEY, production = process.env.CJ_ENV === 'production' } = {}) {
  if (!value && !legacyValue && !production) return null;
  return parseKeyring({ value, legacyValue, envName: 'CJ_DOCUMENT_KEYRING', legacyEnvName: 'CJ_DOCUMENT_KEY', production, devSeed: 'central-juridica-development-document-key-v2', defaultKeyId: 'document-legacy-v1' });
}

function asKeyring(keyOrRing) {
  if (!keyOrRing) return null;
  if (Buffer.isBuffer(keyOrRing)) return makeSingleKeyring(keyOrRing, { keyId: 'document-legacy-v1', source: 'compat-buffer' });
  return keyOrRing;
}

function decryptGcm(ciphertext, key, iv, tag) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw Object.assign(new Error('Falha de autenticação criptográfica do documento.'), { status: 409 });
  }
}

export function encryptBuffer(plain, keyOrRing) {
  if (!keyOrRing) return Buffer.from(plain);
  if (Buffer.isBuffer(keyOrRing)) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyOrRing, iv);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([MAGIC_V1, iv, cipher.getAuthTag(), ciphertext]);
  }
  const ring = asKeyring(keyOrRing);
  const keyIdBytes = Buffer.from(ring.activeKeyId, 'utf8');
  if (keyIdBytes.length > 80) throw new Error('keyId documental excede 80 bytes.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', activeKey(ring), iv);
  const aad = Buffer.concat([MAGIC_V2, Buffer.from([keyIdBytes.length]), keyIdBytes]);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([aad, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptBuffer(payload, keyOrRing) {
  const buffer = Buffer.from(payload);
  if (buffer.subarray(0, MAGIC_V1.length).equals(MAGIC_V1)) {
    const ring = asKeyring(keyOrRing);
    if (!ring) throw Object.assign(new Error('Documento criptografado, mas o keyring documental não está configurado.'), { status: 503 });
    if (buffer.length < MAGIC_V1.length + 12 + 16) throw Object.assign(new Error('Documento criptografado inválido.'), { status: 409 });
    const { key } = resolveKey(ring, null, { allowLegacyFallback: true });
    return decryptGcm(buffer.subarray(MAGIC_V1.length + 28), key, buffer.subarray(MAGIC_V1.length, MAGIC_V1.length + 12), buffer.subarray(MAGIC_V1.length + 12, MAGIC_V1.length + 28));
  }
  if (buffer.subarray(0, MAGIC_V2.length).equals(MAGIC_V2)) {
    const ring = asKeyring(keyOrRing);
    if (!ring) throw Object.assign(new Error('Documento criptografado, mas o keyring documental não está configurado.'), { status: 503 });
    const idLen = buffer[MAGIC_V2.length];
    const idStart = MAGIC_V2.length + 1;
    const idEnd = idStart + idLen;
    if (!idLen || idEnd + 28 > buffer.length) throw Object.assign(new Error('Documento criptografado v2 inválido.'), { status: 409 });
    const keyId = buffer.subarray(idStart, idEnd).toString('utf8');
    let resolved;
    try { resolved = resolveKey(ring, keyId); }
    catch (error) { throw Object.assign(new Error(`Chave documental ${keyId} indisponível.`), { status: 503, code: error.code, keyId }); }
    const iv = buffer.subarray(idEnd, idEnd + 12);
    const tag = buffer.subarray(idEnd + 12, idEnd + 28);
    const ciphertext = buffer.subarray(idEnd + 28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', resolved.key, iv);
    decipher.setAAD(buffer.subarray(0, idEnd));
    decipher.setAuthTag(tag);
    try { return Buffer.concat([decipher.update(ciphertext), decipher.final()]); }
    catch { throw Object.assign(new Error('Falha de autenticação criptográfica do documento.'), { status: 409 }); }
  }
  return buffer;
}

export function encryptedBufferKeyId(payload, { legacyKeyId = 'document-legacy-v1' } = {}) {
  const buffer = Buffer.from(payload);
  if (buffer.subarray(0, MAGIC_V1.length).equals(MAGIC_V1)) return legacyKeyId;
  if (!buffer.subarray(0, MAGIC_V2.length).equals(MAGIC_V2)) return null;
  const idLen = buffer[MAGIC_V2.length];
  return buffer.subarray(MAGIC_V2.length + 1, MAGIC_V2.length + 1 + idLen).toString('utf8');
}

export function isEncryptedBuffer(payload) {
  const b = Buffer.from(payload);
  return b.subarray(0, MAGIC_V1.length).equals(MAGIC_V1) || b.subarray(0, MAGIC_V2.length).equals(MAGIC_V2);
}
