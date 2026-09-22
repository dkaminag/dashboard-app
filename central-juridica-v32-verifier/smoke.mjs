const base = String(process.env.CJ_PREVIEW_BASE_URL || '').trim().replace(/\/+$/,'');
const token = String(process.env.CJ_INTAKE_TOKEN || '').trim();
if (!base || token.length < 32) throw new Error('V32_E2E_CONFIG_MISSING');

async function readJson(response) {
  try { return await response.json(); } catch { return {}; }
}

const health = await fetch(base + '/api/health');
const healthBody = await readJson(health);
if (health.status !== 200 || healthBody.ok !== true || healthBody.version !== '3.2.0-preview') {
  throw new Error('V32_HEALTH_FAILED_' + health.status + '_' + String(healthBody.version || ''));
}

const ready = await fetch(base + '/api/ready');
const readyBody = await readJson(ready);
if (ready.status !== 200 || readyBody.ok !== true) throw new Error('V32_READY_FAILED_' + ready.status);

const key = 'qa-v32-intake-20260922-final-002';
const payload = {
  name: 'Lead QA Preview',
  organization: 'QA Synthetic',
  profileType: 'Empresa',
  email: 'qa-v32-final@example.invalid',
  phone: '',
  preferredChannel: 'E-mail',
  area: 'Trabalhista Empresarial',
  urgency: 'Normal',
  deadlineDate: '',
  source: 'site',
  landingPage: '/qa-preview',
  utmSource: 'qa',
  utmMedium: 'synthetic',
  utmCampaign: 'v32-final-20260922',
  referrer: '',
  contentCluster: 'qa'
};

const unauth = await fetch(base + '/api/intake/leads', {
  method: 'POST',
  headers: {'content-type':'application/json','idempotency-key':key+'-unauth'},
  body: JSON.stringify(payload)
});
if (![401,403].includes(unauth.status)) throw new Error('V32_UNAUTH_NOT_BLOCKED_' + unauth.status);

async function ingest() {
  const response = await fetch(base + '/api/intake/leads', {
    method: 'POST',
    headers: {
      'authorization': 'Bearer ' + token,
      'content-type': 'application/json',
      'idempotency-key': key,
      'x-request-id': key
    },
    body: JSON.stringify(payload)
  });
  return { response, body: await readJson(response) };
}

const first = await ingest();
if (![200,201].includes(first.response.status) || first.body.ok !== true) {
  throw new Error('V32_FIRST_INGEST_FAILED_' + first.response.status + '_' + String(first.body.error || ''));
}
const second = await ingest();
if (![200,201].includes(second.response.status) || second.body.ok !== true || second.body.replayed !== true) {
  throw new Error('V32_REPLAY_FAILED_' + second.response.status + '_' + JSON.stringify(second.body));
}

console.log(JSON.stringify({
  event: 'CENTRAL_JURIDICA_V32_INTAKE_E2E',
  passed: true,
  version: healthBody.version,
  health: health.status,
  ready: ready.status,
  unauth: unauth.status,
  first: first.response.status,
  replay: second.response.status,
  replayed: second.body.replayed === true
}));
