import fs from 'node:fs/promises';

function replaceOnce(source, needle, replacement, code) {
  const first = source.indexOf(needle);
  if (first < 0) throw new Error(code + ':0');
  if (source.indexOf(needle, first + needle.length) >= 0) throw new Error(code + ':MULTIPLE');
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

const moduleSource = `import crypto from 'node:crypto';

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SCHEMA = 'central-legal-agent-human-review-event/v1';
const ATTESTATION = 'REAL_HUMAN_LAWYER_REVIEW';
const ALLOWED = Object.freeze([
  'schema_version',
  'review_target_digest',
  'attestation_kind',
  'structured_identifiers_absent',
  'free_text_identifiers_reviewed',
  'quasi_identifiers_reviewed',
  'reasonable_means_reviewed',
  'privilege_confidentiality_route_reviewed',
  'legal_privacy_review_acknowledged',
  'residual_risk',
  'authority_boundary_acknowledged'
]);

function sha256(value) {
  return 'sha256:' + crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function validReviewTargetDigest(value) {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

export function validateHumanReviewPayload(body, { expectedTargetDigest } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'HUMAN_REVIEW_BODY_INVALID' };
  }
  if (!validReviewTargetDigest(expectedTargetDigest)) {
    return { ok: false, error: 'HUMAN_REVIEW_TARGET_NOT_CONFIGURED' };
  }
  const keys = Object.keys(body).sort();
  const expectedKeys = [...ALLOWED].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return { ok: false, error: 'HUMAN_REVIEW_FIELDS_INVALID' };
  }
  if (body.schema_version !== SCHEMA) return { ok: false, error: 'HUMAN_REVIEW_SCHEMA_INVALID' };
  if (body.attestation_kind !== ATTESTATION) return { ok: false, error: 'HUMAN_REVIEW_ATTESTATION_INVALID' };
  if (!validReviewTargetDigest(body.review_target_digest)) return { ok: false, error: 'HUMAN_REVIEW_DIGEST_INVALID' };
  if (body.review_target_digest !== expectedTargetDigest) return { ok: false, error: 'HUMAN_REVIEW_TARGET_MISMATCH' };
  for (const field of [
    'structured_identifiers_absent',
    'free_text_identifiers_reviewed',
    'quasi_identifiers_reviewed',
    'reasonable_means_reviewed',
    'privilege_confidentiality_route_reviewed',
    'legal_privacy_review_acknowledged',
    'authority_boundary_acknowledged'
  ]) {
    if (body[field] !== true) return { ok: false, error: 'HUMAN_REVIEW_CONFIRMATION_REQUIRED' };
  }
  if (body.residual_risk !== 'LOW') return { ok: false, error: 'HUMAN_REVIEW_RESIDUAL_RISK_NOT_LOW' };
  return { ok: true, value: Object.freeze({ ...body }) };
}

export function buildHumanReviewEvidence({
  value,
  reviewerUserId,
  sessionTokenHash,
  eventId,
  requestId,
  at
}) {
  if (!value || !validReviewTargetDigest(value.review_target_digest)) throw new Error('HUMAN_REVIEW_VALUE_INVALID');
  if (!reviewerUserId || !sessionTokenHash || !eventId || !requestId || !at) throw new Error('HUMAN_REVIEW_BINDING_INVALID');

  const reviewerPrincipalDigest = sha256('central:principal:' + reviewerUserId);
  const reviewerSessionDigest = sha256('central:session:' + sessionTokenHash);
  const eventCore = {
    schema_version: SCHEMA,
    attestation_kind: ATTESTATION,
    attestation_source: 'CENTRAL_SERVER_REVIEW_EVENT',
    review_target_digest: value.review_target_digest,
    reviewer_principal_digest: reviewerPrincipalDigest,
    reviewer_session_digest: reviewerSessionDigest,
    event_id: eventId,
    request_id: requestId,
    at
  };
  const reviewEventDigest = sha256(JSON.stringify(eventCore));

  return Object.freeze({
    schema_version: SCHEMA,
    attestation_kind: ATTESTATION,
    attestation_source: 'CENTRAL_SERVER_REVIEW_EVENT',
    human_reviewed: true,
    reviewer_role: 'lawyer',
    human_review_binding: 'CENTRAL_SERVER_SESSION',
    review_event_digest: reviewEventDigest,
    reviewer_principal_digest: reviewerPrincipalDigest,
    reviewer_session_digest: reviewerSessionDigest,
    review_target_digest: value.review_target_digest,
    mfa_satisfied: true,
    structured_identifiers_absent: true,
    free_text_identifiers_reviewed: true,
    quasi_identifiers_reviewed: true,
    reasonable_means_reviewed: true,
    privilege_confidentiality_route_reviewed: true,
    legal_privacy_review_acknowledged: true,
    residual_risk: 'LOW',
    anonymization_claim: 'NOT_PROVEN',
    authority_boundary_acknowledged: true,
    raw_content_received: false,
    raw_content_persisted: false,
    external_provider_used: false,
    real_source_authorized: false,
    real_matter_authority: false,
    production_authority: false
  });
}
`;

const pageSource = `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Revisão humana — Legal Agent</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <main class="login-shell">
    <form id="reviewForm" class="login-card">
      <p class="eyebrow">Brito &amp; Peovezan</p>
      <h1>Revisão humana — Legal Agent</h1>
      <p class="muted">Revise o pacote transformado apenas no ambiente local/trusted. Esta página recebe somente o digest e confirmações; não cole texto, nomes, documentos ou conteúdo do caso.</p>
      <p id="sessionState" class="muted">Verificando sessão...</p>
      <label>Digest SHA-256 do pacote transformado
        <input id="reviewDigest" name="reviewDigest" autocomplete="off" required pattern="sha256:[0-9a-f]{64}">
      </label>
      <label><input type="checkbox" name="structured" required> Revisei e não identifiquei identificadores estruturados residuais.</label>
      <label><input type="checkbox" name="freeText" required> Revisei o texto livre e não identifiquei pistas razoáveis de reidentificação.</label>
      <label><input type="checkbox" name="quasi" required> Revisei combinações de quasi-identificadores.</label>
      <label><input type="checkbox" name="reasonable" required> Considerei meios razoavelmente disponíveis de reidentificação.</label>
      <label><input type="checkbox" name="privilege" required> Revisei confidencialidade, sigilo e estratégia jurídica residual.</label>
      <label><input type="checkbox" name="privacy" required> Li o checklist jurídico/privacidade assistido e concordo com a avaliação residual LOW para este pacote.</label>
      <label><input type="checkbox" name="authority" required> Entendo que esta revisão não autoriza fonte real, matéria real, provider externo, protocolo, PJe-Calc ou produção.</label>
      <button id="submitReview" type="submit">Registrar revisão humana</button>
      <p id="reviewError" class="error"></p>
      <pre id="reviewReceipt" class="memory hidden"></pre>
      <a href="/">Voltar à Central Jurídica</a>
    </form>
  </main>
  <script src="/human-review.js" defer></script>
</body>
</html>
`;

const jsSource = `const form=document.getElementById('reviewForm');
const digest=document.getElementById('reviewDigest');
const error=document.getElementById('reviewError');
const receipt=document.getElementById('reviewReceipt');
const sessionState=document.getElementById('sessionState');
const params=new URLSearchParams(location.search);
digest.value=params.get('digest')||'';

async function readJson(response){try{return await response.json();}catch{return {};}}
async function checkSession(){
  const response=await fetch('/api/session',{credentials:'same-origin'});
  const body=await readJson(response);
  if(!response.ok){sessionState.textContent='Entre na Central Jurídica e volte a esta página.';return;}
  sessionState.textContent='Sessão autenticada: perfil '+String(body.user?.role||'desconhecido')+'. MFA '+(body.user?.mfa?.enabled?'habilitado':'não habilitado')+'.';
}
form.addEventListener('submit',async event=>{
  event.preventDefault();
  error.textContent='';
  receipt.classList.add('hidden');
  const data=new FormData(form);
  const payload={
    schema_version:'central-legal-agent-human-review-event/v1',
    review_target_digest:String(data.get('reviewDigest')||'').trim(),
    attestation_kind:'REAL_HUMAN_LAWYER_REVIEW',
    structured_identifiers_absent:data.get('structured')==='on',
    free_text_identifiers_reviewed:data.get('freeText')==='on',
    quasi_identifiers_reviewed:data.get('quasi')==='on',
    reasonable_means_reviewed:data.get('reasonable')==='on',
    privilege_confidentiality_route_reviewed:data.get('privilege')==='on',
    legal_privacy_review_acknowledged:data.get('privacy')==='on',
    residual_risk:'LOW',
    authority_boundary_acknowledged:data.get('authority')==='on'
  };
  const response=await fetch('/api/legal-agent/human-review',{
    method:'POST',
    credentials:'same-origin',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(payload)
  });
  const body=await readJson(response);
  if(!response.ok){error.textContent=body.error||('Erro '+response.status);return;}
  receipt.textContent=JSON.stringify(body.evidence,null,2);
  receipt.classList.remove('hidden');
  form.querySelector('button').disabled=true;
});
checkSession().catch(()=>{sessionState.textContent='Não foi possível verificar a sessão.';});
`;

await fs.writeFile(new URL('./runtime/src/legal-agent-human-review.mjs', import.meta.url), moduleSource, 'utf8');
await fs.writeFile(new URL('./runtime/public/human-review.html', import.meta.url), pageSource, 'utf8');
await fs.writeFile(new URL('./runtime/public/human-review.js', import.meta.url), jsSource, 'utf8');

const serverUrl = new URL('./runtime/src/server.mjs', import.meta.url);
let server = await fs.readFile(serverUrl, 'utf8');

const importAnchor = "import { publicLead, validateLeadInput, validateLeadUpdate } from './leads.mjs';";
server = replaceOnce(
  server,
  importAnchor,
  importAnchor + "\nimport { buildHumanReviewEvidence, validateHumanReviewPayload, validReviewTargetDigest } from './legal-agent-human-review.mjs';",
  'HUMAN_REVIEW_IMPORT_ANCHOR'
);

const routeAnchor = "  if (req.method === 'GET' && url.pathname === '/api/audit/integrity') {";
const route = `
  if (req.method === 'POST' && url.pathname === '/api/legal-agent/human-review') {
    if (String(process.env.CJ_LEGAL_HUMAN_REVIEW_ENABLED || '').trim() !== 'true') {
      return json(res, 404, { error: 'HUMAN_REVIEW_NOT_ENABLED' }, requestId);
    }
    if (session.user.role !== 'lawyer') {
      return json(res, 403, { error: 'HUMAN_REVIEW_LAWYER_ROLE_REQUIRED' }, requestId);
    }
    if (!isMfaRequired(session.user.role) || session.user.mfa?.enabled !== true) {
      return json(res, 403, { error: 'HUMAN_REVIEW_MFA_REQUIRED' }, requestId);
    }

    const expectedTargetDigest = String(process.env.CJ_LEGAL_HUMAN_REVIEW_TARGET_DIGEST || '').trim();
    if (!validReviewTargetDigest(expectedTargetDigest)) {
      return json(res, 503, { error: 'HUMAN_REVIEW_TARGET_NOT_CONFIGURED' }, requestId);
    }

    const body = await readBody(req, 16 * 1024);
    const validation = validateHumanReviewPayload(body, { expectedTargetDigest });
    if (!validation.ok) return json(res, 400, { error: validation.error }, requestId);

    const eventId = newId('review');
    const at = new Date().toISOString();
    const evidence = buildHumanReviewEvidence({
      value: validation.value,
      reviewerUserId: session.user.id,
      sessionTokenHash: session.tokenHash,
      eventId,
      requestId,
      at
    });

    await store.mutate(state => {
      const duplicate = (state.auditLog || []).find(entry =>
        entry?.action === 'LEGAL_AGENT_HUMAN_REVIEW_ATTESTED' &&
        entry?.detail?.review_target_digest === expectedTargetDigest
      );
      if (duplicate) throw Object.assign(new Error('HUMAN_REVIEW_ALREADY_ATTESTED'), { status: 409 });
      addAudit(
        state,
        session,
        requestId,
        'LEGAL_AGENT_HUMAN_REVIEW_ATTESTED',
        'legal-agent-human-review',
        eventId,
        evidence
      );
    });

    return json(res, 201, { ok: true, evidence }, requestId);
  }

`;
server = replaceOnce(server, routeAnchor, route + routeAnchor, 'HUMAN_REVIEW_ROUTE_ANCHOR');
await fs.writeFile(serverUrl, server, 'utf8');

console.log(JSON.stringify({
  event: 'central-human-review-route-patched',
  route: '/api/legal-agent/human-review',
  page: '/human-review.html',
  rawContentAccepted: false,
  lawyerOnly: true,
  mfaRequired: true,
  authorityEscalation: false
}));
