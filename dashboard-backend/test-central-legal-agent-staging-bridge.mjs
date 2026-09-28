import assert from "node:assert/strict";

import {
  buildSyntheticStagingRequest,
  createSyntheticMatterResolver,
  executeLegalAgentStagingBridge,
} from "./central-legal-agent-staging-bridge.mjs";

function createAuditSink() {
  const events = [];
  return {
    events,
    async record(event) {
      events.push(structuredClone(event));
    },
  };
}

function createTransport(overrides = {}) {
  const calls = [];
  return {
    calls,
    async send(payload) {
      calls.push(structuredClone(payload));
      return {
        answer:
          "Analise sintetica concluida. AUTHORITY_CHECK_REQUIRED para qualquer autoridade legal atual nao fornecida.",
        citations: [],
        provider: "synthetic-stub",
        ...overrides,
      };
    },
  };
}

function authorizationFor(request) {
  return {
    ref: request.authorization_ref,
    capabilities: [...request.requested_capabilities],
  };
}

async function expectCode(code, fn) {
  let caught = null;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected ${code}`);
  assert.equal(caught.code || caught.message, code);
}

async function main() {
  const request = buildSyntheticStagingRequest();
  const auditSink = createAuditSink();
  const transport = createTransport();

  const result = await executeLegalAgentStagingBridge({
    request,
    operator: { authenticated: true, ref: "central:operator:synthetic-lawyer", role: "lawyer" },
    authorization: authorizationFor(request),
    featureFlagEnabled: true,
    resolver: createSyntheticMatterResolver(),
    auditSink,
    transport,
  });

  assert.equal(result.ok, true);
  assert.equal(result.realMatterAuthority, false);
  assert.equal(result.productionAuthority, false);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].webSearch, false);
  assert.deepEqual(transport.calls[0].files, []);
  assert.equal(transport.calls[0].mode, "CONTRATOS");
  assert.match(transport.calls[0].message, /ESTRITAMENTE SINTETICO/);
  assert.doesNotMatch(transport.calls[0].message, /CPF|CNPJ|processo real/i);

  assert.equal(auditSink.events.length, 2);
  assert.equal(auditSink.events[0].event, "LEGAL_AGENT_STAGING_INVOCATION");
  assert.equal(auditSink.events[0].operatorRole, "lawyer");
  assert.equal(auditSink.events[0].sideEffectsEnabled, false);
  assert.equal(auditSink.events[0].filingEnabled, false);
  assert.equal(auditSink.events[0].pjecalcExportEnabled, false);
  assert.equal(auditSink.events[0].realMatterAuthority, false);
  assert.equal(auditSink.events[0].productionAuthority, false);
  assert.equal(auditSink.events[1].event, "LEGAL_AGENT_STAGING_RESULT");
  assert.equal(auditSink.events[1].rawMatterPayloadRetained, false);

  const serializedAudit = JSON.stringify(auditSink.events);
  assert.doesNotMatch(serializedAudit, /Alfa Ltda/);
  assert.doesNotMatch(serializedAudit, /aviso previo de 30 dias/i);

  await expectCode("STAGING_FEATURE_FLAG_DISABLED", async () => {
    await executeLegalAgentStagingBridge({
      request,
      operator: { authenticated: true, ref: "central:operator:synthetic-lawyer", role: "lawyer" },
      authorization: authorizationFor(request),
      featureFlagEnabled: false,
      resolver: createSyntheticMatterResolver(),
      auditSink: createAuditSink(),
      transport: createTransport(),
    });
  });

  await expectCode("STAGING_OPERATOR_AUTH_REQUIRED", async () => {
    await executeLegalAgentStagingBridge({
      request,
      operator: { authenticated: false, ref: "central:operator:synthetic-lawyer", role: "lawyer" },
      authorization: authorizationFor(request),
      featureFlagEnabled: true,
      resolver: createSyntheticMatterResolver(),
      auditSink: createAuditSink(),
      transport: createTransport(),
    });
  });

  await expectCode("STAGING_OPERATOR_ROLE_BLOCKED", async () => {
    await executeLegalAgentStagingBridge({
      request,
      operator: { authenticated: true, ref: "central:operator:synthetic-assistant", role: "assistant" },
      authorization: authorizationFor(request),
      featureFlagEnabled: true,
      resolver: createSyntheticMatterResolver(),
      auditSink: createAuditSink(),
      transport: createTransport(),
    });
  });

  await expectCode("STAGING_CAPABILITY_NOT_AUTHORIZED", async () => {
    await executeLegalAgentStagingBridge({
      request,
      operator: { authenticated: true, ref: "central:operator:synthetic-lawyer", role: "lawyer" },
      authorization: { ref: request.authorization_ref, capabilities: ["LEGAL_ANALYSIS"] },
      featureFlagEnabled: true,
      resolver: createSyntheticMatterResolver(),
      auditSink: createAuditSink(),
      transport: createTransport(),
    });
  });

  await expectCode("STAGING_SENSITIVITY_BLOCKED", async () => {
    await executeLegalAgentStagingBridge({
      request: { ...request, sensitivity: "LEGAL_PRIVILEGED" },
      operator: { authenticated: true, ref: "central:operator:synthetic-lawyer", role: "lawyer" },
      authorization: authorizationFor(request),
      featureFlagEnabled: true,
      resolver: createSyntheticMatterResolver(),
      auditSink: createAuditSink(),
      transport: createTransport(),
    });
  });

  await expectCode("STAGING_REAL_MATTER_BLOCKED", async () => {
    await executeLegalAgentStagingBridge({
      request: { ...request, matter_ref: "central:matter:real-001" },
      operator: { authenticated: true, ref: "central:operator:synthetic-lawyer", role: "lawyer" },
      authorization: authorizationFor(request),
      featureFlagEnabled: true,
      resolver: createSyntheticMatterResolver(),
      auditSink: createAuditSink(),
      transport: createTransport(),
    });
  });

  await expectCode("STAGING_CAPABILITY_BLOCKED", async () => {
    const withPublicResearch = {
      ...request,
      requested_capabilities: [...request.requested_capabilities, "PUBLIC_RESEARCH"],
    };
    await executeLegalAgentStagingBridge({
      request: withPublicResearch,
      operator: { authenticated: true, ref: "central:operator:synthetic-lawyer", role: "lawyer" },
      authorization: {
        ref: request.authorization_ref,
        capabilities: [...withPublicResearch.requested_capabilities],
      },
      featureFlagEnabled: true,
      resolver: createSyntheticMatterResolver(),
      auditSink: createAuditSink(),
      transport: createTransport(),
    });
  });

  await expectCode("STAGING_UNEXPECTED_PROVIDER_CITATION", async () => {
    await executeLegalAgentStagingBridge({
      request,
      operator: { authenticated: true, ref: "central:operator:synthetic-lawyer", role: "lawyer" },
      authorization: authorizationFor(request),
      featureFlagEnabled: true,
      resolver: createSyntheticMatterResolver(),
      auditSink: createAuditSink(),
      transport: createTransport({ citations: [{ url: "https://example.invalid" }] }),
    });
  });

  console.log(
    JSON.stringify({
      event: "central-legal-agent-staging-bridge-smoke",
      status: "PASS",
      dataMode: "SYNTHETIC",
      realMatterAuthority: false,
      productionAuthority: false,
    }),
  );
}

await main();
