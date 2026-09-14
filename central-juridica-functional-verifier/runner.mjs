import http from 'node:http';
import crypto from 'node:crypto';

const base = String(process.env.TARGET_BASE_URL || '').replace(/\/$/, '');
const username = String(process.env.TEST_USERNAME || '');
const password = String(process.env.TEST_PASSWORD || '');
const port = Number(process.env.PORT || 8080);
if (!base || !username || !password) throw new Error('Missing verifier configuration');

const runId = `qa-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let cookie = '';
const checks = [];
function record(name, ok, detail = {}) { checks.push({ name, ok, ...detail }); if (!ok) throw new Error(`CHECK_FAILED:${name}`); }
async function request(path, { method='GET', body, headers={} } = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  let data = null;
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) data = await r.json();
  else data = Buffer.from(await r.arrayBuffer());
  return { r, data };
}

async function main() {
  let x = await request('/');
  record('root-https', x.r.status === 200 && String(x.r.headers.get('content-type') || '').includes('text/html'));
  record('security-hsts', Boolean(x.r.headers.get('strict-transport-security')));
  record('security-csp', Boolean(x.r.headers.get('content-security-policy')));

  x = await request('/api/login', { method:'POST', body:{ username, password } });
  record('login', x.r.status === 200 && x.data?.ok === true, { status:x.r.status });
  const setCookie = x.r.headers.get('set-cookie') || '';
  cookie = setCookie.split(';')[0];
  record('secure-session-cookie', /cj_session=/.test(setCookie) && /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie) && /Secure/i.test(setCookie));

  x = await request('/api/session');
  record('session', x.r.status === 200 && x.data?.authenticated === true && x.data?.user?.role === 'assistant');

  const clientKey = `client-${runId}`;
  const clientBody = { name:`QA ACCEPTANCE ${runId}`, type:'Empresa', contact:'Synthetic acceptance', status:'Ativo' };
  x = await request('/api/clients', { method:'POST', body:clientBody, headers:{'Idempotency-Key':clientKey} });
  record('client-create', x.r.status === 201 && Boolean(x.data?.client?.id), { status:x.r.status });
  const clientId = x.data.client.id;
  const firstClientId = clientId;
  x = await request('/api/clients', { method:'POST', body:clientBody, headers:{'Idempotency-Key':clientKey} });
  record('client-idempotent-replay', x.r.status === 200 && x.data?.replayed === true && x.data?.client?.id === firstClientId, { status:x.r.status });

  const processKey = `process-${runId}`;
  const processBody = { title:`QA ACCEPTANCE Process ${runId}`, clientId, area:'Cível', risk:'Baixo', status:'Ativo', nextAction:'Synthetic acceptance only', facts:'Synthetic acceptance data', ourThesis:'Synthetic acceptance data', evidence:'Synthetic acceptance data', strategy:'Synthetic acceptance data' };
  x = await request('/api/processes', { method:'POST', body:processBody, headers:{'Idempotency-Key':processKey} });
  record('process-create', x.r.status === 201 && Boolean(x.data?.process?.id), { status:x.r.status });
  const processId = x.data.process.id;

  const taskKey = `task-${runId}`;
  x = await request('/api/tasks', { method:'POST', body:{ title:`QA ACCEPTANCE Task ${runId}`, processId, priority:'Baixa', status:'Pendente', owner:'QA' }, headers:{'Idempotency-Key':taskKey} });
  record('task-create', x.r.status === 201 && Boolean(x.data?.task?.id), { status:x.r.status });

  const bytes = Buffer.from(`Central Juridica QA acceptance ${runId}\n`, 'utf8');
  const documentKey = `document-${runId}`;
  const documentBody = { name:`qa-acceptance-${runId}.txt`, processId, mimeType:'text/plain', contentBase64:bytes.toString('base64') };
  x = await request('/api/documents', { method:'POST', body:documentBody, headers:{'Idempotency-Key':documentKey} });
  record('document-upload', x.r.status === 201 && Boolean(x.data?.document?.id), { status:x.r.status });
  const documentId = x.data.document.id;
  x = await request('/api/documents', { method:'POST', body:documentBody, headers:{'Idempotency-Key':documentKey} });
  record('document-idempotent-replay', x.r.status === 200 && x.data?.document?.id === documentId, { status:x.r.status });
  x = await request(`/api/documents/${encodeURIComponent(documentId)}/content`);
  record('document-download-integrity', x.r.status === 200 && Buffer.isBuffer(x.data) && x.data.equals(bytes), { status:x.r.status });

  x = await request('/api/dashboard');
  record('dashboard-read', x.r.status === 200 && x.data?.stats?.activeClients >= 1 && x.data?.stats?.activeProcesses >= 1, { status:x.r.status });

  x = await request('/api/audit-log');
  record('rbac-audit-denied-for-assistant', x.r.status === 403, { status:x.r.status });

  x = await request('/api/logout', { method:'POST', body:{} });
  record('logout', x.r.status === 200 && x.data?.ok === true, { status:x.r.status });
  cookie = '';
  x = await request('/api/session');
  record('session-revoked', x.r.status === 401, { status:x.r.status });

  console.log(JSON.stringify({ event:'central-juridica-functional-acceptance', ok:true, runId, checks, clientId, processId, documentId }));
}

let ok = false;
try { await main(); ok = true; }
catch (error) { console.error(JSON.stringify({ event:'central-juridica-functional-acceptance', ok:false, error:String(error?.message || error), checks })); }
if (!ok) process.exit(1);

http.createServer((req,res) => {
  if (req.url === '/health') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ok:true, acceptance:true, checks:checks.length})); return; }
  res.writeHead(404); res.end();
}).listen(port, '0.0.0.0');
