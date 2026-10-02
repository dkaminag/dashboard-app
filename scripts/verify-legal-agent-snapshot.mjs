import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('legal-agent-cloud-runtime');
const MANIFEST_PATH = path.join(ROOT, 'SNAPSHOT.json');
const EXPECTED_SOURCE = 'dkaminag/san-systems-master';

function gitBlobSha(data) {
  const header = Buffer.from(`blob ${data.length}\0`, 'ascii');
  return crypto.createHash('sha1').update(header).update(data).digest('hex');
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(absolute));
    else if (entry.isFile()) out.push(absolute);
  }
  return out;
}

function destinationForSource(source) {
  if (source === 'systems/legal-agent-cloud/Dockerfile') {
    return 'Dockerfile';
  }
  if (source.startsWith('systems/legal-agent-cloud/')) {
    return source;
  }
  if (source === 'skills/legal-counsel-br/SKILL.md') {
    return source;
  }
  throw new Error('SNAPSHOT_SOURCE_OUTSIDE_ALLOWLIST:' + source);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

if (manifest.purpose !== 'deployment_snapshot_only') {
  throw new Error('SNAPSHOT_PURPOSE_MISMATCH');
}
if (manifest.source_of_truth !== EXPECTED_SOURCE) {
  throw new Error('SNAPSHOT_SOURCE_OF_TRUTH_MISMATCH');
}
if (!/^[0-9a-f]{40}$/.test(manifest.source_commit || '')) {
  throw new Error('SNAPSHOT_SOURCE_COMMIT_NOT_EXACT');
}
if (manifest.byte_parity !== 'PASS') {
  throw new Error('SNAPSHOT_BYTE_PARITY_NOT_PASS');
}
if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
  throw new Error('SNAPSHOT_FILES_EMPTY');
}

const expectedDestinations = new Set();
const seenSources = new Set();

for (const entry of manifest.files) {
  if (!entry || typeof entry.source !== 'string') {
    throw new Error('SNAPSHOT_SOURCE_INVALID');
  }
  if (!/^[0-9a-f]{40}$/.test(entry.git_blob_sha || '')) {
    throw new Error('SNAPSHOT_BLOB_SHA_INVALID:' + entry.source);
  }
  if (seenSources.has(entry.source)) {
    throw new Error('SNAPSHOT_SOURCE_DUPLICATED:' + entry.source);
  }
  seenSources.add(entry.source);

  const destination = entry.destination || destinationForSource(entry.source);
  const normalized = destination.replaceAll('\\', '/');
  if (
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    path.isAbsolute(destination)
  ) {
    throw new Error('SNAPSHOT_DESTINATION_UNSAFE:' + entry.source);
  }

  const absolute = path.join(ROOT, destination);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error('SNAPSHOT_FILE_MISSING:' + destination);
  }
  const data = fs.readFileSync(absolute);
  const actual = gitBlobSha(data);
  if (actual !== entry.git_blob_sha) {
    throw new Error('SNAPSHOT_BLOB_DRIFT:' + destination);
  }
  if (Number.isInteger(entry.size) && entry.size !== data.length) {
    throw new Error('SNAPSHOT_SIZE_DRIFT:' + destination);
  }
  expectedDestinations.add(path.resolve(absolute));
}

const generatedTrees = [
  path.join(ROOT, 'systems', 'legal-agent-cloud'),
  path.join(ROOT, 'skills', 'legal-counsel-br'),
];
const actualGenerated = new Set([
  ...generatedTrees.flatMap(walkFiles).map((p) => path.resolve(p)),
  path.resolve(path.join(ROOT, 'Dockerfile')),
]);

for (const file of actualGenerated) {
  if (!expectedDestinations.has(file)) {
    throw new Error(
      'SNAPSHOT_UNMANIFESTED_GENERATED_FILE:' +
        path.relative(ROOT, file).replaceAll('\\', '/'),
    );
  }
}
for (const file of expectedDestinations) {
  if (!actualGenerated.has(file)) {
    throw new Error(
      'SNAPSHOT_MANIFEST_POINTS_OUTSIDE_GENERATED_SET:' +
        path.relative(ROOT, file).replaceAll('\\', '/'),
    );
  }
}

console.log(
  JSON.stringify({
    event: 'LEGAL_AGENT_GENERATED_MIRROR_INTEGRITY',
    passed: true,
    sourceOfTruth: manifest.source_of_truth,
    sourceCommit: manifest.source_commit,
    files: manifest.files.length,
    byteParity: manifest.byte_parity,
  }),
);
