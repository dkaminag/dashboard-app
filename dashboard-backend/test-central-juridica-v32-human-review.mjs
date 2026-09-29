import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  buildHumanReviewEvidence,
  validateHumanReviewPayload,
  validReviewTargetDigest
} from './runtime/src/legal-agent-human-review.mjs';

const d = char => 'sha256:' + char.repeat(64);
const target = d('a');
const good = {
  schema_version:'central-legal-agent-human-review-event/v1',
  review_target_digest:target,
  attestation_kind:'REAL_HUMAN_LAWYER_REVIEW',
  structured_identifiers_absent:true,
  free_text_identifiers_reviewed:true,
  quasi_identifiers_reviewed:true,
  reasonable_means_reviewed:true,
  privilege_confidentiality_route_reviewed:true,
  legal_privacy_review_acknowledged:true,
  residual_risk:'LOW',
  authority_boundary_acknowledged:true
};

assert.equal(validReviewTargetDigest(target), true);
assert.equal(validReviewTargetDigest('sha256:not-a-digest'), false);
assert.equal(validateHumanReviewPayload(good,{expectedTargetDigest:target}).ok,true);
assert.equal(validateHumanReviewPayload({...good,review_target_digest:d('b')},{expectedTargetDigest:target}).error,'HUMAN_REVIEW_TARGET_MISMATCH');
assert.equal(validateHumanReviewPayload({...good,free_text_identifiers_reviewed:false},{expectedTargetDigest:target}).error,'HUMAN_REVIEW_CONFIRMATION_REQUIRED');
assert.equal(validateHumanReviewPayload({...good,residual_risk:'MEDIUM'},{expectedTargetDigest:target}).error,'HUMAN_REVIEW_RESIDUAL_RISK_NOT_LOW');
assert.equal(validateHumanReviewPayload({...good,rawText:'forbidden'},{expectedTargetDigest:target}).error,'HUMAN_REVIEW_FIELDS_INVALID');
assert.equal(validateHumanReviewPayload({...good,real_source_authorized:true},{expectedTargetDigest:target}).error,'HUMAN_REVIEW_FIELDS_INVALID');

const evidence=buildHumanReviewEvidence({
  value:good,
  reviewerUserId:'usr-sensitive-id',
  sessionTokenHash:'already-hashed-session-material',
  eventId:'review_test',
  requestId:'req_test',
  at:'2026-09-29T16:00:00.000Z'
});
assert.equal(evidence.human_reviewed,true);
assert.equal(evidence.reviewer_role,'lawyer');
assert.equal(evidence.human_review_binding,'CENTRAL_SERVER_SESSION');
assert.equal(evidence.attestation_source,'CENTRAL_SERVER_REVIEW_EVENT');
assert.equal(evidence.mfa_satisfied,true);
assert.equal(evidence.review_target_digest,target);
assert.match(evidence.review_event_digest,/^sha256:[0-9a-f]{64}$/);
assert.match(evidence.reviewer_principal_digest,/^sha256:[0-9a-f]{64}$/);
assert.match(evidence.reviewer_session_digest,/^sha256:[0-9a-f]{64}$/);
assert.equal(evidence.raw_content_received,false);
assert.equal(evidence.raw_content_persisted,false);
assert.equal(evidence.external_provider_used,false);
assert.equal(evidence.real_source_authorized,false);
assert.equal(evidence.real_matter_authority,false);
assert.equal(evidence.production_authority,false);
assert.equal(evidence.anonymization_claim,'NOT_PROVEN');
const serialized=JSON.stringify(evidence);
assert.equal(serialized.includes('usr-sensitive-id'),false);
assert.equal(serialized.includes('already-hashed-session-material'),false);

const server=await fs.readFile(new URL('./runtime/src/server.mjs',import.meta.url),'utf8');
assert.match(server,/\/api\/legal-agent\/human-review/);
assert.match(server,/session\.user\.role !== 'lawyer'/);
assert.match(server,/!isMfaRequired\(session\.user\.role\)/);
assert.match(server,/CJ_LEGAL_HUMAN_REVIEW_ENABLED/);
assert.match(server,/CJ_LEGAL_HUMAN_REVIEW_TARGET_DIGEST/);
assert.match(server,/LEGAL_AGENT_HUMAN_REVIEW_ATTESTED/);

const html=await fs.readFile(new URL('./runtime/public/human-review.html',import.meta.url),'utf8');
const js=await fs.readFile(new URL('./runtime/public/human-review.js',import.meta.url),'utf8');
assert.equal(/<textarea/i.test(html),false);
assert.equal(/rawText|sourceText|transformedText/.test(js),false);
assert.match(js,/REAL_HUMAN_LAWYER_REVIEW/);
assert.match(js,/authority_boundary_acknowledged/);

console.log(JSON.stringify({
  event:'central-human-review-contract-test',
  status:'PASS',
  rawContentAccepted:false,
  lawyerOnly:true,
  mfaRequired:true,
  authorityEscalation:false
}));
