import {
  buildSyntheticStagingRequest,
  createSyntheticMatterResolver,
  executeLegalAgentStagingBridge,
} from "./central-legal-agent-staging-bridge.mjs";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SESSION_SOURCE = "CENTRAL_SERVER_SESSION";
const LAWYER_CAPABILITIES = Object.freeze([
  "LEGAL_ANALYSIS",
  "ADVERSARIAL_REVIEW",
  "CITATION_AUDIT",
  "DRAFT",
]);
const FORBIDDEN_RAW_FIELDS = new Set([
  "cookie",
  "authorization",
  "token",
  "session",
  "sessionId",
  "session_id",
  "sessionToken",
  "session_token",
  "password",
  "passwordHash",
  "mfa",
  "totp",
  "secret",
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function digest(value, code) {
  const normalized = String(value || "").trim();
  if (!DIGEST_RE.test(normalized)) fail(code);
  return normalized;
}

function assertNoRawSessionMaterial(principal) {
  for (const key of Object.keys(principal || {})) {
    if (FORBIDDEN_RAW_FIELDS.has(key)) fail("STAGING_RAW_SESSION_MATERIAL_BLOCKED");
  }
}

export function bindCentralResolvedSessionPrincipal({ principal, request }) {
  if (!principal || typeof principal !== "object" || Array.isArray(principal)) {
    fail("STAGING_CENTRAL_PRINCIPAL_REQUIRED");
  }
  assertNoRawSessionMaterial(principal);
  if (principal.source !== SESSION_SOURCE) fail("STAGING_IDENTITY_SOURCE_INVALID");
  if (principal.authenticated !== true) fail("STAGING_CENTRAL_SESSION_NOT_AUTHENTICATED");
  if (principal.active !== true) fail("STAGING_CENTRAL_USER_INACTIVE");
  if (String(principal.role || "").trim().toLowerCase() !== "lawyer") {
    fail("STAGING_CENTRAL_ROLE_BLOCKED");
  }
  if (typeof principal.mfa_required !== "boolean" || typeof principal.mfa_satisfied !== "boolean") {
    fail("STAGING_CENTRAL_MFA_ASSURANCE_INVALID");
  }
  if (principal.mfa_required && !principal.mfa_satisfied) {
    fail("STAGING_CENTRAL_MFA_REQUIRED");
  }

  const principalRefDigest = digest(
    principal.principal_ref_digest,
    "STAGING_CENTRAL_PRINCIPAL_DIGEST_INVALID",
  );
  const sessionRefDigest = digest(
    principal.session_ref_digest,
    "STAGING_CENTRAL_SESSION_DIGEST_INVALID",
  );
  const principalHex = principalRefDigest.slice("sha256:".length);

  const requested = new Set(request?.requested_capabilities || []);
  for (const capability of requested) {
    if (!LAWYER_CAPABILITIES.includes(capability)) {
      fail("STAGING_CENTRAL_CAPABILITY_NOT_AUTHORIZED");
    }
  }

  return {
    operator: {
      authenticated: true,
      ref: `central:session-principal:${principalHex}`,
      role: "lawyer",
    },
    authorization: {
      ref: request.authorization_ref,
      capabilities: [...LAWYER_CAPABILITIES],
    },
    identityBindingEvidence: {
      schema_version: "central-legal-agent-session-binding/v1",
      identity_source: SESSION_SOURCE,
      principal_ref_digest: principalRefDigest,
      session_ref_digest: sessionRefDigest,
      role: "lawyer",
      active: true,
      authenticated: true,
      mfa_required: principal.mfa_required,
      mfa_satisfied: principal.mfa_satisfied,
      raw_session_material_retained: false,
      matter_mode: "SYNTHETIC_ONLY",
      real_matter_authority: false,
      production_authority: false,
    },
  };
}

export async function executeCentralSessionSyntheticStaging({
  principal,
  auditSink,
  transport,
  request = buildSyntheticStagingRequest(),
}) {
  const binding = bindCentralResolvedSessionPrincipal({ principal, request });
  const result = await executeLegalAgentStagingBridge({
    request,
    operator: binding.operator,
    authorization: binding.authorization,
    featureFlagEnabled: true,
    resolver: createSyntheticMatterResolver(),
    auditSink,
    transport,
  });

  return {
    ...result,
    identityBindingEvidence: binding.identityBindingEvidence,
    realMatterAuthority: false,
    productionAuthority: false,
  };
}
