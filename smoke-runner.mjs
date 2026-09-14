import http from 'node:http';

await import('./cutover-smoke.mjs');

const port = Number(process.env.PORT || 3000);
const host = '0.0.0.0';
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, gate: 'central-juridica-v3.1.1-cutover-smoke' }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false }));
});
server.listen(port, host, () => {
  console.log(JSON.stringify({ event: 'cutover-smoke-verifier-ready', ok: true, host, port }));
});
