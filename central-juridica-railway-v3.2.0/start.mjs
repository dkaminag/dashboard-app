import http from 'node:http';
import fs from 'node:fs/promises';
import handler from './runtime/src/server.mjs';

const pkg = JSON.parse(await fs.readFile(new URL('./runtime/package.json', import.meta.url), 'utf8'));
const port = Number(process.env.PORT || 3000);
const host = '0.0.0.0';
const server = http.createServer((req, res) => handler(req, res));
server.listen(port, host, () => console.log(JSON.stringify({ level: 'info', event: 'server-listening', host, port, version: pkg.version })));
async function shutdown(signal) {
  console.log(JSON.stringify({ level: 'info', event: 'server-shutdown', signal }));
  server.close(error => process.exit(error ? 1 : 0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
