import fs from 'node:fs/promises';

function replaceExactlyOnce(source, needle, replacement, code) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(code + ':' + count);
  return source.replace(needle, replacement);
}

const auditUrl = new URL('./runtime/src/audit-integrity.mjs', import.meta.url);
let source = await fs.readFile(auditUrl, 'utf8');

const before = `export function loadAuditKeyring({ value = process.env.CJ_AUDIT_KEYRING, legacyValue = process.env.CJ_AUDIT_KEY, production = process.env.CJ_ENV === 'production' } = {}) {
  return parseKeyring({ value, legacyValue, envName: 'CJ_AUDIT_KEYRING', legacyEnvName: 'CJ_AUDIT_KEY', production, devSeed: 'central-juridica-development-audit-integrity-key-v1', defaultKeyId: 'audit-legacy-v1' });
}`;

const after = `export function loadAuditKeyring({ value = process.env.CJ_AUDIT_KEYRING, legacyValue = process.env.CJ_AUDIT_KEY, production = process.env.CJ_ENV === 'production' } = {}) {
  const historicalKeyId = String(process.env.CJ_AUDIT_LEGACY_KEY_ID || '').trim();
  let effectiveValue = value;

  if (value && legacyValue && historicalKeyId) {
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(historicalKeyId)) {
      throw new Error('CJ_AUDIT_LEGACY_KEY_ID inválido.');
    }

    let parsed;
    try { parsed = JSON.parse(String(value)); }
    catch { throw new Error('CJ_AUDIT_KEYRING deve ser JSON válido.'); }

    if (!parsed.keys || typeof parsed.keys !== 'object' || Array.isArray(parsed.keys)) {
      throw new Error('CJ_AUDIT_KEYRING.keys inválido.');
    }

    if (!Object.prototype.hasOwnProperty.call(parsed.keys, historicalKeyId)) {
      parsed = { ...parsed, keys: { ...parsed.keys, [historicalKeyId]: legacyValue } };
      effectiveValue = JSON.stringify(parsed);
    }
  }

  return parseKeyring({ value: effectiveValue, legacyValue, envName: 'CJ_AUDIT_KEYRING', legacyEnvName: 'CJ_AUDIT_KEY', production, devSeed: 'central-juridica-development-audit-integrity-key-v1', defaultKeyId: 'audit-legacy-v1' });
}`;

source = replaceExactlyOnce(source, before, after, 'CJ_AUDIT_KEYRING_COMPAT_PATCH_MISMATCH');
await fs.writeFile(auditUrl, source, 'utf8');

console.log(JSON.stringify({
  event: 'audit-keyring-historical-compat-patched',
  activeKeyUnchanged: true,
  historicalKeySource: 'CJ_AUDIT_KEY',
  historicalKeyIdSource: 'CJ_AUDIT_LEGACY_KEY_ID'
}));
