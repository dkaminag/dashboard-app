import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  createSyntheticMatterResolver,
  executeLegalAgentStagingBridge,
} from "./central-legal-agent-staging-bridge.mjs";

// Test-only artificial fixture: never substitute real client or matter data here.
const SAN_DEIDENTIFIED_GATE_COMMIT = "69957c87b657434b99e9f9b5a3a5805fa12bfdc7";
const SAN_DEIDENTIFIED_MODULE_BLOB = "2a7d1bb1e36152dc375d50fa687fe46e0118f67c";
const SAN_DEIDENTIFIED_SCHEMA_BLOB = "1f04d9a6e74e3053bcaf8ee976519afaf1963bf8";

const SOURCE = `Contrato fictício entre Maria da Silva e Alfa Ltda.
CPF 123.456.789-09; CNPJ 12.345.678/0001-90.
Processo 1234567-89.2026.8.16.0001.
E-mail maria@example.com; telefone (45) 99999-1234.
CEP 85851-000; UUID 550e8400-e29b-41d4-a716-446655440000.
Objeto: prestação de serviços fictícia por prazo determinado.
`;

const REDACTED = `Contrato fictício entre [PARTE_A] e [PARTE_B].
[CPF_REMOVIDO]; [CNPJ_REMOVIDO].
[PROCESSO_REMOVIDO].
[E_MAIL_REMOVIDO]; [TELEFONE_REMOVIDO].
[CEP_REMOVIDO]; [UUID_REMOVIDO].
Objeto: prestação de serviços fictícia por prazo determinado.
`;

const IDENTIFIER_PATTERNS = [
  ["CNJ_PROCESS", /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/],
  ["CPF", /(?<!\d)(?:\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})(?!\d)/],
  ["CNPJ", /(?<!\d)(?:\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{14})(?!\d)/],
  ["EMAIL", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ["UUID", /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/],
  ["CEP", /(?<!\d)(?:\d{5}-\d{3}|\d{8})(?!\d)/],
  ["PHONE", /(?<!\d)(?:\+?55[\s.-]?)?(?:\(?\d{2}\)?[\s.-]?)?(?:9\d{4}|\d{4})[-\s.]?\d{4}(?!\d)/],
];

function sha256(value) {
  return "sha256:" + createHash("sha256").update(String(value), "utf8").digest("hex");
}

function scanStructuredIdentifiers(text) {
  return IDENTIFIER_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name).sort();
}

function createAuditSink() {
  const events = [];
  return {
    events,
    async record(event) {
      events.push(structuredClone(event));
    },
  };
}

function createTransport() {
  const calls = [];
  return {
    calls,
    async send(payload) {
      calls.push(structuredClone(payload));
      return {
        answer: "Resposta de staging para fixture artificial desidentificada. AUTHORITY_CHECK_REQUIRED.",
        citations: [],
        provider: "synthetic-stub",
      };
    },
  };
}

const sourceHits = scanStructuredIdentifiers(SOURCE);
assert.deepEqual(sourceHits, ["CEP", "CNPJ", "CNJ_PROCESS", "CPF", "EMAIL", "PHONE", "UUID"]);
assert.deepEqual(scanStructuredIdentifiers(REDACTED), []);
assert.notEqual(sha256(SOURCE), sha256(REDACTED));

const placeholders = REDACTED.match(/\[[A-Z][A-Z0-9_]{2,79}\]/g) || [];
assert.ok(placeholders.length >= 2);

const deidentificationEvidence = {
  schema_version: "san-legal-agent-deidentified-pilot/v1",
  pilot_scope: "ARTIFICIAL_DEIDENTIFIED_FIXTURE_ONLY",
  san_source_commit: SAN_DEIDENTIFIED_GATE_COMMIT,
  san_module_blob: SAN_DEIDENTIFIED_MODULE_BLOB,
  san_schema_blob: SAN_DEIDENTIFIED_SCHEMA_BLOB,
  source_digest: sha256(SOURCE),
  redacted_digest: sha256(REDACTED),
  redaction_manifest_digest: sha256("artificial-fixture-manifest-v1"),
  structured_identifier_scan_passed: true,
  detected_identifier_types: [],
  placeholder_count: placeholders.length,
  human_reviewed: true,
  reviewer_role: "lawyer",
  free_text_identifiers_reviewed: true,
  raw_source_externalized: false,
  raw_source_persisted: false,
  external_research_mode: "DISABLED",
  attorney_review_required: true,
  real_source_authorized: false,
  real_matter_authority: false,
  production_authority: false,
};

const safeEvidenceSerialized = JSON.stringify(deidentificationEvidence);
assert.doesNotMatch(safeEvidenceSerialized, /Maria da Silva|123\.456\.789-09|maria@example\.com|1234567-89\.2026\.8\.16\.0001/);

const request = {
  schema_version: "san-legal-agent-invocation/v1",
  request_id: "staging-artificial-deidentified-contract-001",
  matter_ref: "synthetic:matter:deidentified-contract-001",
  task_mode: "CONTRATOS",
  sensitivity: "INTERNAL",
  source_refs: ["synthetic:source:deidentified-contract-001"],
  requested_capabilities: ["LEGAL_ANALYSIS", "ADVERSARIAL_REVIEW", "CITATION_AUDIT"],
  requested_output: "CONTRACT_REVIEW",
  authorization_ref: "central:authorization:staging-artificial-deidentified-001",
};

const fixtures = {
  [request.matter_ref]: {
    sourceRefs: [...request.source_refs],
    sources: {
      [request.source_refs[0]]: REDACTED,
    },
  },
};

const auditSink = createAuditSink();
const transport = createTransport();

const result = await executeLegalAgentStagingBridge({
  request,
  operator: {
    authenticated: true,
    ref: "central:operator:artificial-deidentified-lawyer",
    role: "lawyer",
  },
  authorization: {
    ref: request.authorization_ref,
    capabilities: [...request.requested_capabilities],
  },
  featureFlagEnabled: true,
  resolver: createSyntheticMatterResolver(fixtures),
  auditSink,
  transport,
});

assert.equal(result.ok, true);
assert.equal(result.realMatterAuthority, false);
assert.equal(result.productionAuthority, false);
assert.equal(result.stagingEvidence.data_mode, "SYNTHETIC");
assert.equal(result.stagingEvidence.external_research_mode, "DISABLED");
assert.equal(result.stagingEvidence.privileged_payload_externalized, false);
assert.equal(result.stagingEvidence.real_matter_authority, false);
assert.equal(result.stagingEvidence.production_authority, false);

assert.equal(transport.calls.length, 1);
const outbound = JSON.stringify(transport.calls[0]);
assert.match(outbound, /\[PARTE_A\]/);
assert.match(outbound, /\[PROCESSO_REMOVIDO\]/);
assert.doesNotMatch(outbound, /Maria da Silva|123\.456\.789-09|12\.345\.678\/0001-90|maria@example\.com|99999-1234|85851-000|550e8400-e29b-41d4-a716-446655440000/);
assert.equal(transport.calls[0].webSearch, false);
assert.deepEqual(transport.calls[0].files, []);

const auditSerialized = JSON.stringify(auditSink.events);
assert.doesNotMatch(auditSerialized, /Maria da Silva|123\.456\.789-09|maria@example\.com|\[PARTE_A\]/);

const receiptSerialized = JSON.stringify(result.stagingEvidence);
assert.doesNotMatch(receiptSerialized, /Maria da Silva|123\.456\.789-09|maria@example\.com|\[PARTE_A\]/);

console.log(JSON.stringify({
  event: "central-legal-agent-artificial-deidentified-staging-e2e",
  status: "PASS",
  pilotScope: deidentificationEvidence.pilot_scope,
  sanSourceCommit: SAN_DEIDENTIFIED_GATE_COMMIT,
  structuredIdentifierScanPassed: true,
  placeholderCount: placeholders.length,
  rawSourceExternalized: false,
  rawSourcePersisted: false,
  externalResearchMode: "DISABLED",
  stagingDataMode: result.stagingEvidence.data_mode,
  realSourceAuthorized: false,
  realMatterAuthority: false,
  productionAuthority: false,
}));
