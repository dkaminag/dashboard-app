import assert from "node:assert/strict";
import fs from "node:fs";

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
  const schema = JSON.parse(
    fs.readFileSync(
      new URL("../central-legal-agent-staging-runtime/san-legal-agent-staging-evidence-v1.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const evidence = result.stagingEvidence;
  assert.ok(evidence);
  assert.deepEqual(Object.keys(evidence).sort(), [...schema.required].sort());
  assert.equal(evidence.schema_version, "san-legal-agent-staging-evidence/v1");
  assert.equal(evidence.environment, "STAGING");
  assert.equal(evidence.data_mode, "SYNTHETIC");
  assert.equal(evidence.operator_authenticated, true);
  assert.equal(evidence.resolver_trust, "LOCAL_TRUSTED");
  assert.equal(evidence.feature_flag_key, "central.legal_agent.staging");
  assert.equal(evidence.feature_flag_enabled, true);
  assert.equal(evidence.external_research_mode, "DISABLED");
  assert.equal(evidence.privileged_payload_externalized, false);
  assert.equal(evidence.persistence_mode, "DERIVED_ONLY");
  assert.equal(evidence.side_effects_enabled, false);
  assert.equal(evidence.filing_enabled, false);
  assert.equal(evidence.pjecalc_export_enabled, false);
  assert.equal(evidence.retry_mode, "IDEMPOTENT_READ_ONLY");
  assert.equal(evidence.synthetic_e2e_passed, true);
  assert.equal(evidence.attorney_review_required, true);
  assert.equal(evidence.real_matter_authority, false);
  assert.equal(evidence.production_authority, false);
  for (const field of [
    "invocation_digest",
    "authorization_mapping_digest",
    "matter_ref_digest",
    "source_refs_digest",
    "audit_event_digest",
  ]) {
    assert.match(evidence[field], /^sha256:[0-9a-f]{64}$/);
  }
  const serializedEvidence = JSON.stringify(evidence);
  assert.doesNotMatch(serializedEvidence, /Alfa Ltda|aviso previo|synthetic:matter:contract-001|synthetic:source:contract-001/i);
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
