import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const encoded = String(process.env.CJ_SMOKE_SCRIPT_B64 || '').trim();
if (!encoded) {
  console.error('[smoke] CJ_SMOKE_SCRIPT_B64 ausente');
  process.exit(2);
}

const decoded = Buffer.from(encoded, 'base64').toString('utf8');
if (!decoded.trim()) {
  console.error('[smoke] script decodificado vazio');
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'cj-smoke-'));
const isShell = /^\s*#!.*\b(?:ba|z|k)?sh\b/.test(decoded) || /^\s*(?:set\s+-|curl\s+)/m.test(decoded);
const scriptPath = join(dir, isShell ? 'smoke.sh' : 'smoke.mjs');
writeFileSync(scriptPath, decoded, { mode: 0o700 });

const env = {
  ...process.env,
  BASE_URL: process.env.BASE_URL || process.env.CJ_PUBLIC_BASE_URL || '',
  NODE_ENV: 'production',
  CI: 'true'
};

const result = isShell
  ? spawnSync('bash', [scriptPath], { env, encoding: 'utf8', timeout: 120000 })
  : spawnSync(process.execPath, [scriptPath], { env, encoding: 'utf8', timeout: 120000 });

const smokePassed = result.status === 0 && !result.error;
console.log(JSON.stringify({
  event: 'central-juridica-authenticated-smoke',
  version: '3.1.1',
  passed: smokePassed,
  runner: isShell ? 'bash' : 'node',
  exitCode: result.status ?? null,
  signal: result.signal ?? null,
  timedOut: result.error?.code === 'ETIMEDOUT'
}));

if (!smokePassed) {
  console.error('[smoke] FAIL — saída do script suprimida para evitar exposição de segredos');
}

const port = Number(process.env.PORT || 8080);
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.statusCode = smokePassed ? 200 : 503;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: smokePassed, smoke: 'authenticated-synthetic', version: '3.1.1' }));
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

server.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'smoke-verifier-listening', port, healthy: smokePassed }));
});
