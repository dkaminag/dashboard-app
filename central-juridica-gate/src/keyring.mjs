import crypto from 'node:crypto';

function decodeKey(value, label) {
  let key;
  try { key = Buffer.from(String(value || ''), 'base64url'); } catch { key = null; }
  if (!key || key.length !== 32) throw new Error(`${label} deve conter chave base64url de exatamente 32 bytes.`);
  return key;
}
function devKey(seed) { return crypto.createHash('sha256').update(seed).digest(); }
export function makeSingleKeyring(key, { keyId = 'legacy-v1', source = 'legacy' } = {}) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new TypeError('Keyring exige chave de 32 bytes.');
  return { activeKeyId: keyId, legacyKeyId: keyId, source, keys: new Map([[keyId, Buffer.from(key)]]) };
}
export function parseKeyring({ value, legacyValue, envName, legacyEnvName, production = false, devSeed, defaultKeyId = 'legacy-v1' }) {
  if (value) {
    let parsed; try { parsed = JSON.parse(String(value)); } catch { throw new Error(`${envName} deve ser JSON válido.`); }
    const activeKeyId = String(parsed.activeKeyId || '').trim();
    const legacyKeyId = String(parsed.legacyKeyId || activeKeyId).trim();
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(activeKeyId)) throw new Error(`${envName}.activeKeyId inválido.`);
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(legacyKeyId)) throw new Error(`${envName}.legacyKeyId inválido.`);
    const entries = parsed.keys && typeof parsed.keys === 'object' && !Array.isArray(parsed.keys) ? Object.entries(parsed.keys) : [];
    if (!entries.length) throw new Error(`${envName}.keys não pode ser vazio.`);
    const keys = new Map();
    for (const [keyId, encoded] of entries) { if (!/^[A-Za-z0-9._:-]{1,80}$/.test(keyId)) throw new Error(`${envName}.keys contém keyId inválido.`); keys.set(keyId, decodeKey(encoded, `${envName}.keys.${keyId}`)); }
    if (!keys.has(activeKeyId)) throw new Error(`${envName} não contém a chave ativa ${activeKeyId}.`);
    if (!keys.has(legacyKeyId)) throw new Error(`${envName} não contém a chave legada ${legacyKeyId}.`);
    return { activeKeyId, legacyKeyId, source: 'keyring', keys };
  }
  if (legacyValue) return makeSingleKeyring(decodeKey(legacyValue, legacyEnvName), { keyId: defaultKeyId, source: 'legacy-env' });
  if (production) throw new Error(`Modo production exige ${envName} ou ${legacyEnvName}.`);
  return makeSingleKeyring(devKey(devSeed), { keyId: 'development-v1', source: 'development' });
}
export function activeKey(keyring) { if (!keyring?.keys?.has(keyring.activeKeyId)) throw new Error('Keyring sem chave ativa.'); return keyring.keys.get(keyring.activeKeyId); }
export function resolveKey(keyring, keyId, { allowLegacyFallback = false } = {}) {
  if (!keyring?.keys) throw new Error('Keyring inválido.');
  const resolvedId = keyId || (allowLegacyFallback ? keyring.legacyKeyId : null);
  if (!resolvedId || !keyring.keys.has(resolvedId)) throw Object.assign(new Error(`Chave ${resolvedId || '(sem keyId)'} não disponível no keyring.`), { code: 'KEY_NOT_FOUND', keyId: resolvedId || null });
  return { keyId: resolvedId, key: keyring.keys.get(resolvedId) };
}
export function publicKeyringStatus(keyring) { return { activeKeyId: keyring.activeKeyId, legacyKeyId: keyring.legacyKeyId, knownKeyIds: [...keyring.keys.keys()].sort(), keyCount: keyring.keys.size, source: keyring.source }; }
