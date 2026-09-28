import assert from "node:assert/strict";

import {
  bindCentralResolvedSessionPrincipal,
  executeCentralSessionSyntheticStaging,
} from "./central-legal-agent-session-binding.mjs";
import { buildSyntheticStagingRequest } from "./central-legal-agent-staging-bridge.mjs";

function d(char) {
  return "sha256:" + char.repeat(64);
}

function principal(overrides = {}) {
  return {
    source: "CENTRAL_SERVER_SESSION",
    authenticated: true,
    active: true,
    role: "lawyer",
    principal_ref_digest: d("a"),
    session_ref_digest: d("b"),
    mfa_required: true,
    mfa_satisfied: true,
    ...overrides,
  };
}

function auditSink() {
  const events = [];
  return {
    events,
    async record(event) {
      events.push(structuredClone(event));
    },
  };
}

function transport() {
  const calls = [];
  return {
    calls,
    async send(payload) {
      calls.push(structuredClone(payload));
      return {
        answer: "Analise sintetica concluida. AUTHORITY_CHECK_REQUIRED.",
        citations: [],
      };
    },
  };
}

function expectCode(code, fn) {
  let error = null;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `expected ${code}`);
  assert.equal(error.code || error.message, code);
}

const request = buildSyntheticStagingRequest();
const binding = bindCentralResolvedSessionPrincipal({
  principal: principal(),
  request,
});
assert.equal(binding.operator.authenticated, true);
assert.equal(binding.operator.role, "lawyer");
assert.match(binding.operator.ref, /^central:session-principal:[0-9a-f]{64}$/);
assert.equal(binding.authorization.ref, request.authorization_ref);
assert.ok(binding.authorization.capabilities.includes("LEGAL_ANALYSIS"));
assert.equal(binding.identityBindingEvidence.identity_source, "CENTRAL_SERVER_SESSION");
assert.equal(binding.identityBindingEvidence.raw_session_material_retained, false);
assert.equal(binding.identityBindingEvidence.matter_mode, "SYNTHETIC_ONLY");
assert.equal(binding.identityBindingEvidence.real_matter_authority, false);
assert.equal(binding.identityBindingEvidence.production_authority, false);

for (const [code, candidate] of [
  ["STAGING_CENTRAL_SESSION_NOT_AUTHENTICATED", principal({ authenticated: false })],
  ["STAGING_CENTRAL_USER_INACTIVE", principal({ active: false })],
  ["STAGING_CENTRAL_ROLE_BLOCKED", principal({ role: "assistant" })],
  ["STAGING_CENTRAL_MFA_REQUIRED", principal({ mfa_required: true, mfa_satisfied: false })],
  ["STAGING_CENTRAL_PRINCIPAL_DIGEST_INVALID", principal({ principal_ref_digest: "bad" })],
  ["STAGING_CENTRAL_SESSION_DIGEST_INVALID", principal({ session_ref_digest: "bad" })],
]) {
  expectCode(code, () => bindCentralResolvedSessionPrincipal({ principal: candidate, request }));
}

expectCode("STAGING_RAW_SESSION_MATERIAL_BLOCKED", () =>
  bindCentralResolvedSessionPrincipal({
    principal: principal({ session_token: "must-never-cross-boundary" }),
    request,
  }),
);

const sink = auditSink();
const tx = transport();
const result = await executeCentralSessionSyntheticStaging({
  principal: principal(),
  auditSink: sink,
  transport: tx,
});
assert.equal(result.ok, true);
assert.equal(result.realMatterAuthority, false);
assert.equal(result.productionAuthority, false);
assert.equal(result.identityBindingEvidence.authenticated, true);
assert.equal(result.identityBindingEvidence.role, "lawyer");
assert.equal(tx.calls.length, 1);
assert.equal(tx.calls[0].webSearch, false);
assert.deepEqual(tx.calls[0].files, []);
assert.match(tx.calls[0].message, /ESTRITAMENTE SINTETICO/);
assert.equal(sink.events.length, 2);

const serialized = JSON.stringify({ result, audit: sink.events });
assert.doesNotMatch(serialized, /must-never-cross-boundary/);
assert.doesNotMatch(serialized, /cookie|session_token|passwordHash/i);

console.log(JSON.stringify({
  event: "central-real-session-synthetic-staging-binding",
  status: "PASS",
  identitySource: "CENTRAL_SERVER_SESSION",
  realMatterAuthority: false,
  productionAuthority: false,
}));
