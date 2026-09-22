import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'e844ca9b1ef15500971daba024c33e2cd15fd054';
const SOURCE = '42aeae42db77ac2f4ad964ad1415df2539943b1c';
const EXPECTED = [
  'central-juridica-railway-v3.2.0/intake-e2e-smoke.mjs',
  'dashboard-backend/Dockerfile.central-juridica-v32-preview',
].sort();

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

if (git(['merge-base', BASE, SOURCE]) !== BASE) {
  throw new Error('CJ_V32_BASE_LINEAGE_MISMATCH');
}
if (git(['rev-list', '--count', BASE + '..' + SOURCE]) !== '2') {
  throw new Error('CJ_V32_SOURCE_COMMIT_COUNT_MISMATCH');
}

const changed = git(['diff', '--name-only', BASE + '..' + SOURCE])
  .split('\n')
  .filter(Boolean)
  .sort();

if (JSON.stringify(changed) !== JSON.stringify(EXPECTED)) {
  throw new Error('CJ_V32_SOURCE_FILE_DELTA_MISMATCH:' + JSON.stringify(changed));
}

execFileSync('git', [
  'diff',
  '--exit-code',
  SOURCE,
  '--',
  'central-juridica-railway-v3.2.0',
  'dashboard-backend/Dockerfile.central-juridica-v32-preview',
], { stdio: 'inherit' });

const packageRoot = path.resolve('central-juridica-railway-v3.2.0');
const overlayNames = fs.readdirSync(packageRoot)
  .filter((name) => /^overlay\.v3\.2\.0\.part\d+\.b64$/.test(name))
  .sort();

if (overlayNames.length !== 9) {
  throw new Error('OVERLAY_PART_COUNT:' + overlayNames.length);
}

const encoded = overlayNames
  .map((name) => fs.readFileSync(path.join(packageRoot, name), 'utf8'))
  .join('')
  .replace(/\s+/g, '');

if (encoded.length !== 41924) {
  throw new Error('OVERLAY_TEXT_LENGTH:' + encoded.length);
}

const overlaySha = crypto.createHash('sha256').update(encoded, 'utf8').digest('hex');
if (overlaySha !== 'ffa471575efe3a63e410241611e70efa9e118d100abdf124c40912a5b404ca75') {
  throw new Error('OVERLAY_TEXT_SHA:' + overlaySha);
}

const dockerfile = fs.readFileSync(
  path.resolve('dashboard-backend/Dockerfile.central-juridica-v32-preview'),
  'utf8',
);
if (!dockerfile.includes('a20b5020164b247f127dad34467f0af584214226')) {
  throw new Error('IMMUTABLE_DOCKER_SOURCE_PIN_MISSING');
}
if (/tar\.gz\/(main|master|HEAD)(?:['"\s]|$)/.test(dockerfile)) {
  throw new Error('MUTABLE_DOCKER_SOURCE_REF');
}

console.log(JSON.stringify({
  event: 'CENTRAL_JURIDICA_V32_SOURCE_CERTIFICATION',
  passed: true,
  base: BASE,
  source: SOURCE,
  commits: 2,
  changedFiles: changed,
  overlayParts: overlayNames.length,
  overlayTextSha256: overlaySha,
  productionMutated: false,
}));
