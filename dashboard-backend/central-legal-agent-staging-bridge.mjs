import { createHash } from "node:crypto";

const REQUEST_SCHEMA = "san-legal-agent-invocation/v1";
const ALLOWED_SENSITIVITY = new Set(["PUBLIC", "INTERNAL"]);
const ALLOWED_MODES = new Set(["PARECER", "CONTRATOS", "ADVERSARIAL_REVIEW"]);
const ALLOWED_CAPABILITIES = new Set([
  "LEGAL_ANALYSIS",
  "ADVERSARIAL_REVIEW",
  "CITATION_AUDIT",
  "DRAFT",
]);
const ALLOWED_OUTPUTS = new Set([
  "LEGAL_OPINION",
  "CONTRACT_REVIEW",
  "REVIEW_REPORT",
]);

const SYNTHETIC_FIXTURES = Object.freeze({
  "synthetic:matter:contract-001": Object.freeze({
    sourceRefs: Object.freeze(["synthetic:source:contract-001"]),
    sources: Object.freeze({
      "synthetic:source:contract-001":
        "CASO ESTRITAMENTE SINTETICO: Alfa Ltda. celebrou contrato de prestacao de servicos por 12 meses. O contrato preve aviso previo de 30 dias e multa equivalente a uma mensalidade para rescisao imotivada. A contratante encerrou imediatamente, sem aviso. Nao ha identificadores pessoais, dados de cliente, estrategia privilegiada ou documento real neste fixture.",
    }),
  }),
});

function sha256(value) {
  return "sha256:" + createHash("sha256").update(String(value), "utf8").digest("hex");
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function assertReference(value, code) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,499}$/.test(normalized)) fail(code);
  if (normalized.includes("://") || /(^|\/)\.{1,2}(\/|$)/.test(normalized)) fail(code);
  return normalized;
}

export function createSyntheticMatterResolver(fixtures = SYNTHETIC_FIXTURES) {
  return {
    trust: "LOCAL_TRUSTED",
    resolve(matterRef, sourceRefs) {
      const matter = fixtures[matterRef];
      if (!matter) fail("STAGING_MATTER_NOT_SYNTHETIC");
      const requested = [...sourceRefs];
      if (requested.length === 0) fail("STAGING_SOURCE_REQUIRED");
      if (requested.some((ref) => !matter.sourceRefs.includes(ref))) {
        fail("STAGING_SOURCE_NOT_BOUND_TO_MATTER");
      }
      const sources = requested.map((ref) => {
        const text = matter.sources[ref];
        if (!text) fail("STAGING_SOURCE_NOT_FOUND");
        return { ref, text };
      });
      return { matterRef, sources };
    },
  };
}

export function buildSyntheticStagingRequest() {
  return {
    schema_version: REQUEST_SCHEMA,
    request_id: "staging-synthetic-contract-001",
    matter_ref: "synthetic:matter:contract-001",
    task_mode: "CONTRATOS",
    sensitivity: "INTERNAL",
    source_refs: ["synthetic:source:contract-001"],
    requested_capabilities: ["LEGAL_ANALYSIS", "ADVERSARIAL_REVIEW", "CITATION_AUDIT"],
    requested_output: "CONTRACT_REVIEW",
    authorization_ref: "central:authorization:staging-synthetic-001",
  };
}

function validateInvocation(request) {
  if (!request || request.schema_version !== REQUEST_SCHEMA) fail("STAGING_INVOCATION_SCHEMA_INVALID");
  assertReference(request.request_id, "STAGING_REQUEST_ID_INVALID");
  assertReference(request.matter_ref, "STAGING_MATTER_REF_INVALID");
  if (!String(request.matter_ref).startsWith("synthetic:")) fail("STAGING_REAL_MATTER_BLOCKED");
  if (!ALLOWED_MODES.has(request.task_mode)) fail("STAGING_MODE_BLOCKED");
  if (!ALLOWED_SENSITIVITY.has(request.sensitivity)) fail("STAGING_SENSITIVITY_BLOCKED");
  if (!Array.isArray(request.source_refs) || request.source_refs.length < 1 || request.source_refs.length > 200) {
    fail("STAGING_SOURCE_REFS_INVALID");
  }
  for (const ref of request.source_refs) {
    assertReference(ref, "STAGING_SOURCE_REF_INVALID");
    if (!String(ref).startsWith("synthetic:")) fail("STAGING_REAL_SOURCE_BLOCKED");
  }
  if (!Array.isArray(request.requested_capabilities) || request.requested_capabilities.length < 1) {
    fail("STAGING_CAPABILITY_REQUIRED");
  }
  for (const capability of request.requested_capabilities) {
    if (!ALLOWED_CAPABILITIES.has(capability)) fail("STAGING_CAPABILITY_BLOCKED");
  }
  if (!ALLOWED_OUTPUTS.has(request.requested_output)) fail("STAGING_OUTPUT_BLOCKED");
  if (!request.authorization_ref) fail("STAGING_AUTHORIZATION_REF_REQUIRED");
  assertReference(request.authorization_ref, "STAGING_AUTHORIZATION_REF_INVALID");
  return request;
}

function validateAuthorization(request, operator, authorization) {
  if (!operator?.authenticated) fail("STAGING_OPERATOR_AUTH_REQUIRED");
  const operatorRef = assertReference(operator.ref, "STAGING_OPERATOR_REF_INVALID");
  const authorizationRef = assertReference(authorization?.ref, "STAGING_AUTHORIZATION_INVALID");
  if (authorizationRef !== request.authorization_ref) fail("STAGING_AUTHORIZATION_REF_MISMATCH");
  const allowed = new Set(authorization?.capabilities || []);
  for (const capability of request.requested_capabilities) {
    if (!allowed.has(capability)) fail("STAGING_CAPABILITY_NOT_AUTHORIZED");
  }
  return { operatorRef, authorizationRef };
}

function buildPrompt(resolved) {
  return [
    "AMBIENTE DE STAGING. CONTEUDO ESTRITAMENTE SINTETICO.",
    "Nao trate este material como cliente, processo ou fato real.",
    "Pesquisa publica esta desabilitada. Nao invente autoridade; use AUTHORITY_CHECK_REQUIRED quando necessario.",
    ...resolved.sources.map((source, index) => `FONTE_SINTETICA_${index + 1}: ${source.text}`),
  ].join("\n\n");
}

export async function executeLegalAgentStagingBridge({
  request,
  operator,
  authorization,
  featureFlagEnabled,
  resolver,
  auditSink,
  transport,
}) {
  validateInvocation(request);
  const auth = validateAuthorization(request, operator, authorization);

  if (featureFlagEnabled !== true) fail("STAGING_FEATURE_FLAG_DISABLED");
  if (!resolver || resolver.trust !== "LOCAL_TRUSTED" || typeof resolver.resolve !== "function") {
    fail("STAGING_RESOLVER_NOT_LOCAL_TRUSTED");
  }
  if (!auditSink || typeof auditSink.record !== "function") fail("STAGING_AUDIT_SINK_REQUIRED");
  if (!transport || typeof transport.send !== "function") fail("STAGING_TRANSPORT_REQUIRED");

  const resolved = resolver.resolve(request.matter_ref, request.source_refs);
  const requestDigest = sha256(JSON.stringify({
    request_id: request.request_id,
    task_mode: request.task_mode,
    sensitivity: request.sensitivity,
    requested_capabilities: request.requested_capabilities,
    requested_output: request.requested_output,
  }));
  const matterRefDigest = sha256(request.matter_ref);
  const sourceRefsDigest = sha256(JSON.stringify(request.source_refs));

  await auditSink.record({
    event: "LEGAL_AGENT_STAGING_INVOCATION",
    requestDigest,
    matterRefDigest,
    sourceRefsDigest,
    sourceCount: request.source_refs.length,
    operatorRef: auth.operatorRef,
    authorizationRef: auth.authorizationRef,
    dataMode: "SYNTHETIC",
    resolverTrust: "LOCAL_TRUSTED",
    externalResearchMode: "DISABLED",
    persistenceMode: "DERIVED_ONLY",
    sideEffectsEnabled: false,
    filingEnabled: false,
    pjecalcExportEnabled: false,
    retryMode: "IDEMPOTENT_READ_ONLY",
    realMatterAuthority: false,
    productionAuthority: false,
  });

  const payload = {
    mode: request.task_mode,
    webSearch: false,
    files: [],
    message: buildPrompt(resolved),
  };

  const response = await transport.send(payload);
  if (!response || typeof response.answer !== "string" || !response.answer.trim()) {
    fail("STAGING_LEGAL_AGENT_RESPONSE_INVALID");
  }
  if (Array.isArray(response.citations) && response.citations.length !== 0) {
    fail("STAGING_UNEXPECTED_PROVIDER_CITATION");
  }

  await auditSink.record({
    event: "LEGAL_AGENT_STAGING_RESULT",
    requestDigest,
    matterRefDigest,
    answerDigest: sha256(response.answer),
    citationCount: Array.isArray(response.citations) ? response.citations.length : 0,
    outcome: "PASS",
    rawMatterPayloadRetained: false,
    realMatterAuthority: false,
    productionAuthority: false,
  });

  return {
    ok: true,
    requestDigest,
    matterRefDigest,
    sourceRefsDigest,
    answer: response.answer,
    citations: Array.isArray(response.citations) ? response.citations : [],
    realMatterAuthority: false,
    productionAuthority: false,
  };
}
