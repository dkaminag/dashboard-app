import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BASE = '6d1858690c7c298f5100cee97f01bb0a07ddb4bc';
const SOURCE = 'eabfb4da6b4e5207cb25d569c5e434829c2e5614';
const EXPECTED = [
  'central-juridica-railway-v3.2.0/final-drill.mjs',
  'central-juridica-railway-v3.2.0/package.json',
  'central-juridica-v32-verifier/DEPLOY_REV_20260922_1511.txt',
  'central-juridica-v32-verifier/package.json',
  'central-juridica-v32-verifier/server.mjs',
  'central-juridica-v32-verifier/smoke.mjs',
].sort();

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

if (git(['merge-base', BASE, SOURCE]) !== BASE) {
  throw new Error('CJ_V32_BASE_LINEAGE_MISMATCH');
}
if (git(['rev-list', '--count', BASE + '..' + SOURCE]) !== '6') {
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
  'central-juridica-v32-verifier',
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

const drill = fs.readFileSync(path.join(packageRoot, 'final-drill.mjs'), 'utf8');
for (const required of [
  'FINAL_DR_SOURCE_TARGET_NOT_ISOLATED',
  'FINAL_DR_BACKUP_VERIFY_FAILED',
  'FINAL_DR_SEMANTIC_FINGERPRINT_MISMATCH',
  'FINAL_DR_SESSIONS_RESTORED',
  'FINAL_KEY_BACKUP_RESTORE_VERIFIED',
]) {
  if (!drill.includes(required)) throw new Error('DR_FAIL_CLOSED_INVARIANT_MISSING:' + required);
}

const verifierRoot = path.resolve('central-juridica-v32-verifier');
const smoke = fs.readFileSync(path.join(verifierRoot, 'smoke.mjs'), 'utf8');
for (const required of [
  'V32_E2E_CONFIG_MISSING',
  'V32_HEALTH_FAILED_',
  'V32_READY_FAILED_',
  'V32_UNAUTH_NOT_BLOCKED_',
  'V32_FIRST_INGEST_FAILED_',
  'V32_REPLAY_FAILED_',
  'CENTRAL_JURIDICA_V32_INTAKE_E2E',
  'replayed: second.body.replayed === true',
]) {
  if (!smoke.includes(required)) throw new Error('VERIFIER_FAIL_CLOSED_INVARIANT_MISSING:' + required);
}

console.log(JSON.stringify({
  event: 'CENTRAL_JURIDICA_V32_RUNTIME_SOURCE_CERTIFICATION',
  passed: true,
  base: BASE,
  source: SOURCE,
  commits: 6,
  changedFiles: changed,
  overlayParts: overlayNames.length,
  overlayTextSha256: overlaySha,
  productionMutated: false,
}));
