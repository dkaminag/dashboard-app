import crypto from 'node:crypto';

const base = String(process.env.CJ_PREVIEW_BASE_URL || '').trim().replace(/\/+$/,'');
const token = String(process.env.CJ_INTAKE_TOKEN || '').trim();
const qaUser = String(process.env.CJ_QA_USER || '').trim();
const qaPassword = String(process.env.CJ_QA_PASSWORD || '');
const intakeOnly = String(process.env.CJ_QA_SMOKE_MODE || '').trim() === 'intake-only';
if (!base || token.length < 32) throw new Error('V32_E2E_CONFIG_MISSING');
if (!intakeOnly && (!qaUser || !qaPassword)) throw new Error('QA_SMOKE_CONFIG_MISSING');

async function readJson(response) { try { return await response.json(); } catch { return {}; } }

const ui = await fetch(base + '/');
const uiType = String(ui.headers.get('content-type') || '').toLowerCase();
const uiBody = await ui.text();
if (ui.status !== 200 || !uiType.includes('text/html') || uiBody.trim().length < 100) {
  throw new Error('V32_UI_FAILED_' + ui.status + '_' + uiType + '_' + uiBody.length);
}

const health = await fetch(base + '/api/health');
const healthBody = await readJson(health);
if (health.status !== 200 || healthBody.ok !== true || healthBody.version !== '3.2.0-preview') {
  throw new Error('V32_HEALTH_FAILED_' + health.status + '_' + String(healthBody.version || ''));
}
const ready = await fetch(base + '/api/ready');
const readyBody = await readJson(ready);
if (ready.status !== 200 || readyBody.ok !== true) throw new Error('V32_READY_FAILED_' + ready.status);

const unauthDashboard = await fetch(base + '/api/dashboard');
if (unauthDashboard.status !== 401) throw new Error('QA_UNAUTH_DASHBOARD_NOT_BLOCKED_' + unauthDashboard.status);

let loginStatus = null;
let sessionStatus = null;
let dashboardStatus = null;
let logoutStatus = null;
let staleStatus = null;
let auditGatesStatus = null;
let auditGatesProductionReady = null;
let auditGatesDecision = null;

if (!intakeOnly) {
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: {'content-type':'application/json','origin':base},
    body: JSON.stringify({username:qaUser,password:qaPassword})
  });
  const setCookie = login.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  loginStatus = login.status;
  if (login.status !== 200 || !cookie) throw new Error('QA_LOGIN_FAILED_' + login.status);
  const authHeaders = {cookie};
  const session = await fetch(base + '/api/session', {headers:authHeaders});
  const dashboard = await fetch(base + '/api/dashboard', {headers:authHeaders});
  sessionStatus = session.status;
  dashboardStatus = dashboard.status;
  if (session.status !== 200 || dashboard.status !== 200) throw new Error('QA_AUTH_FLOW_FAILED_' + session.status + '_' + dashboard.status);
  const gates = await fetch(base + '/api/audit/gates', {headers:authHeaders});
  const gatesBody = await readJson(gates);
  auditGatesStatus = gates.status;
  auditGatesProductionReady = gatesBody.productionReady ?? gatesBody.production_ready ?? null;
  auditGatesDecision = gatesBody.decision ?? null;
  if (gates.status !== 200) throw new Error('QA_AUDIT_GATES_FAILED_' + gates.status);
  const logout = await fetch(base + '/api/logout', {
    method:'POST',
    headers:{'content-type':'application/json','origin':base,cookie},
    body:'{}'
  });
  const stale = await fetch(base + '/api/session', {headers:authHeaders});
  logoutStatus = logout.status;
  staleStatus = stale.status;
  if (logout.status !== 200 || stale.status !== 401) throw new Error('QA_LOGOUT_FLOW_FAILED_' + logout.status + '_' + stale.status);
}

const runNonce = String(process.env.RAILWAY_DEPLOYMENT_ID || crypto.randomUUID()).replace(/[^a-zA-Z0-9-]/g,'').slice(0,48);
const key = 'qa-v32-intake-' + runNonce;
const payload = {
  name: 'Lead QA Preview ' + runNonce.slice(-8),
  organization: 'QA Synthetic',
  profileType: 'Empresa',
  email: 'qa-v32-' + runNonce.toLowerCase() + '@example.invalid',
  phone: '',
  preferredChannel: 'E-mail',
  area: 'Trabalhista Empresarial',
  urgency: 'Normal',
  deadlineDate: '',
  source: 'site',
  landingPage: '/qa-preview',
  utmSource: 'qa',
  utmMedium: 'synthetic',
  utmCampaign: 'v32-live-' + runNonce,
  referrer: '',
  contentCluster: 'qa'
};

const unauthIntake = await fetch(base + '/api/intake/leads', {
  method:'POST',
  headers:{'content-type':'application/json','idempotency-key':key+'-unauth'},
  body:JSON.stringify(payload)
});
if (![401,403].includes(unauthIntake.status)) throw new Error('V32_UNAUTH_NOT_BLOCKED_' + unauthIntake.status);

async function ingest() {
  const response = await fetch(base + '/api/intake/leads', {
    method:'POST',
    headers:{
      authorization:'Bearer ' + token,
      'content-type':'application/json',
      'idempotency-key':key,
      'x-request-id':key
    },
    body:JSON.stringify(payload)
  });
  return {response,body:await readJson(response)};
}

const first = await ingest();
if (first.response.status !== 201 || first.body.ok !== true || first.body.replayed === true) {
  throw new Error('V32_FIRST_INGEST_FAILED_' + first.response.status + '_' + String(first.body.error || ''));
}
const replay = await ingest();
if (replay.response.status !== 200 || replay.body.ok !== true || replay.body.replayed !== true) {
  throw new Error('V32_REPLAY_FAILED_' + replay.response.status + '_' + JSON.stringify(replay.body));
}

console.log(JSON.stringify({
  event:'CENTRAL_JURIDICA_V32_COMBINED_SMOKE',
  passed:true,
  version:healthBody.version,
  ui:ui.status,
  uiHtml:true,
  health:health.status,
  ready:ready.status,
  unauthDashboard:unauthDashboard.status,
  smokeMode:intakeOnly ? 'intake-only' : 'full',
  login:loginStatus,
  session:sessionStatus,
  dashboard:dashboardStatus,
  auditGates:auditGatesStatus,
  auditGatesProductionReady,
  auditGatesDecision,
  logout:logoutStatus,
  staleSession:staleStatus,
  unauthIntake:unauthIntake.status,
  firstIntake:first.response.status,
  replayIntake:replay.response.status,
  replayed:true,
  syntheticIdentityUnique:true
}));

// R2 final fresh-source UI smoke: 2026-09-24
