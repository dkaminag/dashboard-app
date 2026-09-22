import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const EXPECTED_TEXT_SHA256 = 'ffa471575efe3a63e410241611e70efa9e118d100abdf124c40912a5b404ca75';
const EXPECTED_RAW_SHA256 = '476b58ebfb70d3ccd42d64de84fedec38b6281c7e196064a0bda5df1c3a87267';
const EXPECTED_VERSION = '3.2.0-preview';
const ALLOWED = new Set([
  'contracts/central-juridica-intake-v1.openapi.json',
  'package.json',
  'src/auth.mjs',
  'src/intake-auth.mjs',
  'src/leads.mjs',
  'src/postgres-leads.mjs',
  'src/postgres-store.mjs',
  'src/runtime-readiness.mjs',
  'src/server.mjs',
  'src/store.mjs'
]);

const dir = new URL('./', import.meta.url);
const names = (await fs.readdir(dir))
  .filter(name => /^overlay\.v3\.2\.0\.part\d+\.b64$/.test(name))
  .sort();

if (names.length !== 9) throw new Error(`INTAKE_OVERLAY_PART_COUNT:${names.length}`);

const encoded = (await Promise.all(names.map(name => fs.readFile(new URL(name, dir), 'utf8'))))
  .join('')
  .replace(/\s+/g, '');

const textHash = crypto.createHash('sha256').update(encoded, 'utf8').digest('hex');
if (textHash !== EXPECTED_TEXT_SHA256) throw new Error(`INTAKE_OVERLAY_TEXT_SHA_MISMATCH:${textHash}`);

const compressed = Buffer.from(encoded, 'base64');
const rawHash = crypto.createHash('sha256').update(compressed).digest('hex');
if (rawHash !== EXPECTED_RAW_SHA256) throw new Error(`INTAKE_OVERLAY_RAW_SHA_MISMATCH:${rawHash}`);

const overlay = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
const keys = Object.keys(overlay).sort();
if (keys.length !== ALLOWED.size || keys.some(key => !ALLOWED.has(key))) {
  throw new Error(`INTAKE_OVERLAY_PATH_POLICY:${keys.join(',')}`);
}

const runtimeRoot = new URL('./runtime/', import.meta.url);
for (const [relative, content] of Object.entries(overlay)) {
  if (typeof content !== 'string' || relative.includes('..')) throw new Error(`INTAKE_OVERLAY_INVALID_FILE:${relative}`);
  const target = new URL(relative, runtimeRoot);
  await fs.mkdir(new URL('./', target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

const pkg = JSON.parse(await fs.readFile(new URL('./runtime/package.json', import.meta.url), 'utf8'));
if (pkg.version !== EXPECTED_VERSION) throw new Error(`INTAKE_OVERLAY_VERSION:${pkg.version}`);

console.log(JSON.stringify({
  event: 'intake-overlay-applied',
  version: pkg.version,
  files: keys.length,
  textSha256: textHash,
  rawSha256: rawHash
}));
