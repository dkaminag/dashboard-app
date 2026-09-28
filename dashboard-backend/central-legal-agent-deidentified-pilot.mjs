import { createHash } from "node:crypto";
import {
  executeLegalAgentStagingBridge,
} from "./central-legal-agent-staging-bridge.mjs";
import {
  bindCentralResolvedSessionPrincipal,
} from "./central-legal-agent-session-binding.mjs";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const REAL_REVIEW_ATTESTATION = "REAL_HUMAN_LAWYER_REVIEW";
const TEST_REVIEW_ATTESTATION = "TEST_ONLY_SYNTHETIC_REVIEW";
const CENTRAL_REVIEW_EVENT_SOURCE = "CENTRAL_SERVER_REVIEW_EVENT";
const PLACEHOLDER_RE = /\[[A-Z][A-Z0-9_]{2,79}\]/g;
const IDENTIFIERS = Object.freeze([
  ["CNJ_PROCESS", /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/],
  ["CPF", /(?<!\d)(?:\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})(?!\d)/],
  ["CNPJ", /(?<!\d)(?:\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|\d{14})(?!\d)/],
  ["EMAIL", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ["UUID", /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/],
  ["CEP", /(?<!\d)(?:\d{5}-\d{3}|\d{8})(?!\d)/],
  ["PHONE", /(?<!\d)(?:\+?55[\s.-]?)?(?:\(?\d{2}\)?[\s.-]?)?(?:9\d{4}|\d{4})[-\s.]?\d{4}(?!\d)/],
]);

export const ARTIFICIAL_SOURCE = [
  "FIXTURE ARTIFICIAL. Empresa Exemplo Ltda., CNPJ 12.345.678/0001-90,",
  "discute contrato com Pessoa Teste, CPF 123.456.789-00, no processo",
  "1234567-89.2026.8.16.0001. Contato teste@example.invalid, telefone",
  "(45) 91234-5678, CEP 85851-000. Nenhum dado corresponde a cliente real.",
].join(" ");

export const ARTIFICIAL_REDACTED = [
  "FIXTURE ARTIFICIAL. [EMPRESA_A], identificada apenas como [PARTE_A],",
  "discute contrato com [PESSOA_A] no [PROCESSO_A].",
  "Contato e endereço foram substituídos por [CONTATO_A] e [ENDERECO_A].",
  "Nenhum dado corresponde a cliente real.",
].join(" ");

export const ARTIFICIAL_REDACTION_MANIFEST = Object.freeze([
  "CNPJ->[EMPRESA_A]",
  "CPF->[PESSOA_A]",
  "CNJ_PROCESS->[PROCESSO_A]",
  "EMAIL+PHONE->[CONTATO_A]",
  "CEP->[ENDERECO_A]",
]);

function sha256(value) {
  return "sha256:" + createHash("sha256").update(String(value), "utf8").digest("hex");
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function scanStructuredIdentifiers(text) {
  return IDENTIFIERS.filter(([, regex]) => regex.test(text)).map(([name]) => name).sort();
}

function validateRealHumanReviewBinding({ humanReview, centralPrincipal, request }) {
  if (humanReview.attestationKind !== REAL_REVIEW_ATTESTATION) {
    fail("DEID_REAL_HUMAN_REVIEW_ATTESTATION_REQUIRED");
  }
  if (humanReview.attestationSource !== CENTRAL_REVIEW_EVENT_SOURCE) {
    fail("DEID_REVIEW_EVENT_SOURCE_INVALID");
  }
  if (!DIGEST_RE.test(String(humanReview.reviewEventDigest || ""))) {
    fail("DEID_REVIEW_EVENT_DIGEST_INVALID");
  }
  if (!DIGEST_RE.test(String(humanReview.reviewerPrincipalDigest || ""))) {
    fail("DEID_REVIEW_PRINCIPAL_DIGEST_INVALID");
  }
  if (!DIGEST_RE.test(String(humanReview.reviewerSessionDigest || ""))) {
    fail("DEID_REVIEW_SESSION_DIGEST_INVALID");
  }
  if (humanReview.reviewTargetDigest !== sha256(ARTIFICIAL_REDACTED)) {
    fail("DEID_REVIEW_TARGET_MISMATCH");
  }
  if (!centralPrincipal || typeof centralPrincipal !== "object") {
    fail("DEID_CENTRAL_PRINCIPAL_REQUIRED");
  }

  const binding = bindCentralResolvedSessionPrincipal({
    principal: centralPrincipal,
    request,
  });
  if (humanReview.reviewerPrincipalDigest !== binding.identityBindingEvidence.principal_ref_digest) {
    fail("DEID_REVIEW_PRINCIPAL_MISMATCH");
  }
  if (humanReview.reviewerSessionDigest !== binding.identityBindingEvidence.session_ref_digest) {
    fail("DEID_REVIEW_SESSION_MISMATCH");
  }
  return binding;
}

function buildEvidence({ humanReview }) {
  const detected = scanStructuredIdentifiers(ARTIFICIAL_REDACTED);
  const placeholders = ARTIFICIAL_REDACTED.match(PLACEHOLDER_RE) || [];
  return {
    schema_version: "san-legal-agent-deidentified-pilot/v1",
    pilot_scope: "ARTIFICIAL_DEIDENTIFIED_FIXTURE_ONLY",
    source_digest: sha256(ARTIFICIAL_SOURCE),
    redacted_digest: sha256(ARTIFICIAL_REDACTED),
    redaction_manifest_digest: sha256(JSON.stringify(ARTIFICIAL_REDACTION_MANIFEST)),
    structured_identifier_scan_passed: detected.length === 0,
    detected_identifier_types: detected,
    placeholder_count: placeholders.length,
    human_reviewed: humanReview.reviewed === true,
    reviewer_role: humanReview.role,
    free_text_identifiers_reviewed: humanReview.freeTextReviewed === true,
    raw_source_externalized: false,
    raw_source_persisted: false,
    external_research_mode: "DISABLED",
    attorney_review_required: true,
    real_source_authorized: false,
    real_matter_authority: false,
    production_authority: false,
  };
}

function validateEvidence(evidence) {
  if (evidence.schema_version !== "san-legal-agent-deidentified-pilot/v1") fail("DEID_SCHEMA_INVALID");
  if (evidence.pilot_scope !== "ARTIFICIAL_DEIDENTIFIED_FIXTURE_ONLY") fail("DEID_SCOPE_INVALID");
  for (const field of ["source_digest", "redacted_digest", "redaction_manifest_digest"]) {
    if (!DIGEST_RE.test(evidence[field])) fail("DEID_DIGEST_INVALID");
  }
  if (!evidence.structured_identifier_scan_passed || evidence.detected_identifier_types.length !== 0) {
    fail("DEID_STRUCTURED_IDENTIFIER_REMAINS");
  }
  if (evidence.placeholder_count < 2) fail("DEID_PLACEHOLDERS_INCOMPLETE");
  if (!evidence.human_reviewed || evidence.reviewer_role !== "lawyer") fail("DEID_LAWYER_REVIEW_REQUIRED");
  if (!evidence.free_text_identifiers_reviewed) fail("DEID_FREE_TEXT_REVIEW_REQUIRED");
  if (evidence.raw_source_externalized || evidence.raw_source_persisted) fail("DEID_RAW_SOURCE_BOUNDARY_VIOLATION");
  if (evidence.external_research_mode !== "DISABLED") fail("DEID_EXTERNAL_RESEARCH_BLOCKED");
  if (evidence.real_source_authorized || evidence.real_matter_authority || evidence.production_authority) {
    fail("DEID_AUTHORITY_ESCALATION_BLOCKED");
  }
  return evidence;
}

export function createArtificialDeidentifiedFixtureEvidence({ humanReview }) {
  if (!humanReview || typeof humanReview !== "object") fail("DEID_REVIEW_ATTESTATION_REQUIRED");
  const evidence = buildEvidence({ humanReview });
  return validateEvidence(evidence);
}

export function createArtificialDeidentifiedResolver() {
  return {
    trust: "LOCAL_TRUSTED",
    resolve(matterRef, sourceRefs) {
      if (matterRef !== "synthetic:matter:deidentified-artificial-001") fail("DEID_MATTER_REF_BLOCKED");
      if (!Array.isArray(sourceRefs) || sourceRefs.length !== 1 || sourceRefs[0] !== "synthetic:source:deidentified-artificial-001") {
        fail("DEID_SOURCE_REF_BLOCKED");
      }
      return {
        matterRef,
        sources: [{ ref: sourceRefs[0], text: ARTIFICIAL_REDACTED }],
      };
    },
  };
}

export function buildArtificialDeidentifiedRequest() {
  return {
    schema_version: "san-legal-agent-invocation/v1",
    request_id: "staging-deidentified-artificial-001",
    matter_ref: "synthetic:matter:deidentified-artificial-001",
    task_mode: "CONTRATOS",
    sensitivity: "INTERNAL",
    source_refs: ["synthetic:source:deidentified-artificial-001"],
    requested_capabilities: ["LEGAL_ANALYSIS", "ADVERSARIAL_REVIEW", "CITATION_AUDIT"],
    requested_output: "CONTRACT_REVIEW",
    authorization_ref: "central:authorization:deidentified-artificial-001",
  };
}

export async function executeArtificialDeidentifiedStagingPilot({
  operator,
  authorization,
  centralPrincipal,
  auditSink,
  transport,
  humanReview,
  technicalE2EOnly = false,
}) {
  const evidence = createArtificialDeidentifiedFixtureEvidence({ humanReview });
  const request = buildArtificialDeidentifiedRequest();

  let effectiveOperator = operator;
  let effectiveAuthorization = authorization;
  let identityBindingEvidence = null;

  if (technicalE2EOnly === true) {
    if (humanReview.attestationKind !== TEST_REVIEW_ATTESTATION) {
      fail("DEID_TEST_ATTESTATION_REQUIRED");
    }
  } else {
    const binding = validateRealHumanReviewBinding({
      humanReview,
      centralPrincipal,
      request,
    });
    effectiveOperator = binding.operator;
    effectiveAuthorization = binding.authorization;
    identityBindingEvidence = binding.identityBindingEvidence;
  }

  const result = await executeLegalAgentStagingBridge({
    request,
    operator: effectiveOperator,
    authorization: effectiveAuthorization,
    featureFlagEnabled: true,
    resolver: createArtificialDeidentifiedResolver(),
    auditSink,
    transport,
  });

  return {
    ...result,
    deidentifiedPilotEvidence: evidence,
    identityBindingEvidence,
    technicalE2EOnly,
    humanReviewAuthority: technicalE2EOnly ? false : true,
    realSourceAuthorized: false,
    realMatterAuthority: false,
    productionAuthority: false,
  };
}
