import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const required = ['CJ_DATABASE_URL', 'CJ_DR_DATABASE_URL', 'CJ_FINAL_DRILL_SCRIPT_B64', 'CJ_BACKUP_KEYRING'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`DR_MISSING_${key}`);
}
if (process.env.CJ_DATABASE_URL === process.env.CJ_DR_DATABASE_URL) {
  throw new Error('DR_DESTINATION_EQUALS_SOURCE');
}

const drillPath = path.join(process.cwd(), 'final-drill.mjs');
fs.writeFileSync(drillPath, Buffer.from(process.env.CJ_FINAL_DRILL_SCRIPT_B64, 'base64'), { mode: 0o600 });
console.log(JSON.stringify({ event: 'dr-preflight', sourceTargetDistinct: true, scriptConfigured: true, version: '3.1.1' }));

try {
  const result = spawnSync(process.execPath, [drillPath], { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  console.log(JSON.stringify({ event: 'dr-drill-complete', ok: true, version: '3.1.1' }));
} finally {
  try { fs.unlinkSync(drillPath); } catch {}
}
