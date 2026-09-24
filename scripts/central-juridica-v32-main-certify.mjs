import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const APPROVED_PATH_SOURCES = [
  {
    path: 'central-juridica-railway-v3.2.0',
    source: '4f17a25183ac3f54a01626457e9d959d688c7828',
  },
  {
    path: 'dashboard-backend/Dockerfile.central-juridica-v32-preview',
    source: '969674b99e773adebe54e7a9a316ce6a3e0ad865',
  },
  {
    path: 'central-juridica-v32-verifier',
    source: '0e9242c7189513697f4bc4d31c99c37afde6f6fa',
  },
];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

for (const approved of APPROVED_PATH_SOURCES) {
  if (git(['merge-base', approved.source, 'HEAD']) !== approved.source) {
    throw new Error('CJ_V32_APPROVED_SOURCE_NOT_ANCESTOR:' + approved.path);
  }
  execFileSync('git', [
    'diff',
    '--exit-code',
    approved.source,
    '--',
    approved.path,
  ], { stdio: 'inherit' });
}

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
if (!dockerfile.includes('d507a9955be07ef710d410b5263686ac75caeeff')) {
  throw new Error('IMMUTABLE_DOCKER_SOURCE_PIN_MISSING');
}
if (/tar\.gz\/(main|master|HEAD)(?:['"\s]|$)/.test(dockerfile)) {
  throw new Error('MUTABLE_DOCKER_SOURCE_REF');
}
if (!dockerfile.includes('/central-juridica-railway-v3.2.0/package.json')) {
  throw new Error('CURRENT_V32_PACKAGE_PATH_MISSING');
}
if (dockerfile.includes('/central-juridica-railway-v3.1.1/package.json')) {
  throw new Error('STALE_V31_PACKAGE_PATH_PRESENT');
}

const drill = fs.readFileSync(path.join(packageRoot, 'final-drill.mjs'), 'utf8');
for (const required of [
  'FINAL_DR_REQUIRES_PRODUCTION_ENV',
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
  'CENTRAL_JURIDICA_V32_COMBINED_SMOKE',
  'replayed:true',
  'CJ_ADMIN_CREDENTIAL_RESYNC',
  'ADMIN_AUDIT_GATE_CONFIG_MISSING',
]) {
  if (!smoke.includes(required)) throw new Error('VERIFIER_FAIL_CLOSED_INVARIANT_MISSING:' + required);
}

console.log(JSON.stringify({
  event: 'CENTRAL_JURIDICA_V32_RUNTIME_SOURCE_CERTIFICATION',
  passed: true,
  approvedPathSources: APPROVED_PATH_SOURCES,
  overlayParts: overlayNames.length,
  overlayTextSha256: overlaySha,
  productionMutated: false,
}));
