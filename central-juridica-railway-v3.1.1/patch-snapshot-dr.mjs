import fs from 'node:fs/promises';

const target = new URL('./runtime/src/postgres-store.mjs', import.meta.url);
let source = await fs.readFile(target, 'utf8');

const locked = "SELECT state FROM central_juridica_state WHERE singleton = TRUE FOR SHARE";
const unlocked = "SELECT state FROM central_juridica_state WHERE singleton = TRUE";
const occurrences = source.split(locked).length - 1;
if (occurrences !== 1) throw new Error(`DR_SNAPSHOT_PATCH_EXPECTED_ONE_MATCH:${occurrences}`);
if (!source.includes("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")) {
  throw new Error('DR_SNAPSHOT_PATCH_READ_ONLY_TX_NOT_FOUND');
}

source = source.replace(locked, unlocked);
source = source.replace(
  '// SHARE conflicts with the FOR UPDATE mutation lock and keeps state + blobs aligned during the snapshot.',
  '// REPEATABLE READ provides one MVCC snapshot across state + blobs; row locks are invalid in READ ONLY transactions.'
);

await fs.writeFile(target, source, 'utf8');
console.log(JSON.stringify({event:'dr-snapshot-readonly-patch',patched:true,matches:occurrences}));
