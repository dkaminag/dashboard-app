import assert from "node:assert/strict";
import fs from "node:fs";

import {
  ARTIFICIAL_REDACTED,
  ARTIFICIAL_SOURCE,
  buildArtificialDeidentifiedRequest,
  createArtificialDeidentifiedFixtureEvidence,
  executeArtificialDeidentifiedStagingPilot,
} from "./central-legal-agent-deidentified-pilot.mjs";

function auditSink() {
  const events = [];
  return { events, async record(event) { events.push(structuredClone(event)); } };
}

function transport() {
  const calls = [];
  return {
    calls,
    async send(payload) {
      calls.push(structuredClone(payload));
      return {
        answer: "Analise da fixture artificial desidentificada concluida. AUTHORITY_CHECK_REQUIRED.",
        citations: [],
      };
    },
  };
}

async function expectCode(code, fn) {
  let error = null;
  try { await fn(); } catch (caught) { error = caught; }
  assert.ok(error, `expected ${code}`);
  assert.equal(error.code || error.message, code);
}

const schema = JSON.parse(
  fs.readFileSync(new URL("./san-legal-agent-deidentified-pilot-v1.schema.json", import.meta.url), "utf8"),
);

const testReview = {
  reviewed: true,
  role: "lawyer",
  freeTextReviewed: true,
  attestationKind: "TEST_ONLY_SYNTHETIC_REVIEW",
};

const evidence = createArtificialDeidentifiedFixtureEvidence({ humanReview: testReview });
assert.deepEqual(Object.keys(evidence).sort(), [...schema.required].sort());
assert.equal(evidence.pilot_scope, "ARTIFICIAL_DEIDENTIFIED_FIXTURE_ONLY");
assert.equal(evidence.structured_identifier_scan_passed, true);
assert.deepEqual(evidence.detected_identifier_types, []);
assert.ok(evidence.placeholder_count >= 2);
assert.equal(evidence.raw_source_externalized, false);
assert.equal(evidence.raw_source_persisted, false);
assert.equal(evidence.real_source_authorized, false);
assert.equal(evidence.real_matter_authority, false);
assert.equal(evidence.production_authority, false);
assert.match(evidence.source_digest, /^sha256:[0-9a-f]{64}$/);
assert.match(evidence.redacted_digest, /^sha256:[0-9a-f]{64}$/);
assert.notEqual(evidence.source_digest, evidence.redacted_digest);

assert.match(ARTIFICIAL_SOURCE, /12\.345\.678\/0001-90/);
assert.match(ARTIFICIAL_SOURCE, /123\.456\.789-00/);
assert.match(ARTIFICIAL_SOURCE, /1234567-89\.2026\.8\.16\.0001/);
assert.doesNotMatch(ARTIFICIAL_REDACTED, /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/);
assert.doesNotMatch(ARTIFICIAL_REDACTED, /\d{3}\.\d{3}\.\d{3}-\d{2}/);
assert.doesNotMatch(ARTIFICIAL_REDACTED, /@/);

const request = buildArtificialDeidentifiedRequest();
const sink = auditSink();
const tx = transport();
const result = await executeArtificialDeidentifiedStagingPilot({
  operator: { authenticated: true, ref: "central:operator:synthetic-lawyer", role: "lawyer" },
  authorization: { ref: request.authorization_ref, capabilities: [...request.requested_capabilities] },
  auditSink: sink,
  transport: tx,
  humanReview: testReview,
  technicalE2EOnly: true,
});

assert.equal(result.ok, true);
assert.equal(result.technicalE2EOnly, true);
assert.equal(result.humanReviewAuthority, false);
assert.equal(result.realSourceAuthorized, false);
assert.equal(result.realMatterAuthority, false);
assert.equal(result.productionAuthority, false);
assert.equal(result.deidentifiedPilotEvidence.structured_identifier_scan_passed, true);
assert.equal(tx.calls.length, 1);
assert.equal(tx.calls[0].webSearch, false);
assert.deepEqual(tx.calls[0].files, []);
assert.match(tx.calls[0].message, /\[EMPRESA_A\]/);
assert.doesNotMatch(tx.calls[0].message, /12\.345\.678\/0001-90|123\.456\.789-00|1234567-89\.2026\.8\.16\.0001|teste@example\.invalid/);

await expectCode("DEID_LAWYER_REVIEW_REQUIRED", async () => {
  createArtificialDeidentifiedFixtureEvidence({
    humanReview: { ...testReview, reviewed: false },
  });
});

await expectCode("DEID_REAL_HUMAN_REVIEW_ATTESTATION_REQUIRED", async () => {
  await executeArtificialDeidentifiedStagingPilot({
    operator: { authenticated: true, ref: "central:operator:synthetic-lawyer", role: "lawyer" },
    authorization: { ref: request.authorization_ref, capabilities: [...request.requested_capabilities] },
    auditSink: auditSink(),
    transport: transport(),
    humanReview: testReview,
    technicalE2EOnly: false,
  });
});

console.log(JSON.stringify({
  event: "central-artificial-deidentified-staging-e2e",
  status: "PASS",
  technicalE2EOnly: true,
  humanReviewAuthority: false,
  realSourceAuthorized: false,
  realMatterAuthority: false,
  productionAuthority: false,
}));
