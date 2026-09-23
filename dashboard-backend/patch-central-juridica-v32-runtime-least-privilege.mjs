import fs from 'node:fs/promises';

function replaceExactlyOnce(source, pattern, replacement, code) {
  const matches = source.match(pattern);
  if (!matches || matches.length !== 1) throw new Error(code + ':' + (matches?.length || 0));
  return source.replace(pattern, replacement);
}

const serverUrl = new URL('./runtime/src/server.mjs', import.meta.url);
let server = await fs.readFile(serverUrl, 'utf8');
server = replaceExactlyOnce(
  server,
  /await store\.ensure\(\);\r?\nawait rateLimiter\.ensure\(\);/g,
  `if (process.env.CJ_SCHEMA_PREPARED !== 'true') {
  await store.ensure();
  await rateLimiter.ensure();
}`,
  'CJ_SCHEMA_PATCH_SERVER_MISMATCH'
);
await fs.writeFile(serverUrl, server, 'utf8');

const drillUrl = new URL('./final-drill.mjs', import.meta.url);
let drill = await fs.readFile(drillUrl, 'utf8');
drill = replaceExactlyOnce(
  drill,
  /  await source\.store\.ensure\(\);\r?\n  await target\.store\.ensure\(\);/g,
  `  if (process.env.CJ_SCHEMA_PREPARED !== 'true') {
    await source.store.ensure();
    await target.store.ensure();
  }`,
  'CJ_SCHEMA_PATCH_DRILL_MISMATCH'
);
await fs.writeFile(drillUrl, drill, 'utf8');

console.log(JSON.stringify({
  event: 'runtime-schema-ownership-separated',
  serverDdlSkippedWhenPrepared: true,
  drDdlSkippedWhenPrepared: true
}));
