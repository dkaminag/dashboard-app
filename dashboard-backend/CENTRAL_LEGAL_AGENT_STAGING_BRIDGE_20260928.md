# Central Jurídica → Legal Agent staging bridge — 2026-09-28

## Status

**IMPLEMENTED + ISOLATED RUNTIME CERTIFIED / SYNTHETIC ONLY / RAILWAY DEPLOY BLOCKED_RESOURCE**

This bridge is the vertical implementation candidate for the SAN pre-real-matter staging gate.

It is intentionally not connected to the canonical Central Jurídica v3.2 runtime and does not alter production watch paths, variables, credentials, database schema, MFA or the Legal Agent service.

## Scope

The bridge accepts only the SAN invocation shape and then narrows it further:

- matter references must use the `synthetic:` namespace;
- source references must use the `synthetic:` namespace;
- sensitivity is limited to `PUBLIC` or `INTERNAL`;
- modes are limited to `PARECER`, `CONTRATOS` and `ADVERSARIAL_REVIEW`;
- capabilities are limited to analysis/draft/review controls;
- `PUBLIC_RESEARCH` is blocked;
- `PJECALC_PREPARE` is blocked;
- feature flag must be explicitly ON;
- operator must be authenticated;
- operator role must be the verified Central legal role `lawyer`;
- the synthetic QA role `assistant` is explicitly blocked;
- requested capabilities must be present in the authorization evidence;
- resolver must be `LOCAL_TRUSTED`;
- transport is invoked with `webSearch=false` and no files;
- audit events contain digests/references only, not source text;
- no retry is performed by the bridge;
- no filing or export path exists;
- real-matter and production authority are always false.

## Synthetic fixture

The only bundled fixture is a fictitious service-contract scenario under:

- matter: `synthetic:matter:contract-001`;
- source: `synthetic:source:contract-001`.

It contains no real client, process, CPF, CNPJ, privileged strategy or real document.

## CI contract

`dashboard-backend/test-central-legal-agent-staging-bridge.mjs` proves:

- happy-path synthetic invocation;
- flag OFF blocks execution;
- unauthenticated operator blocks execution;
- operator role `assistant` blocks execution;
- operator role `lawyer` is required for this staging bridge;
- missing capability authorization blocks execution;
- `LEGAL_PRIVILEGED` is rejected;
- non-synthetic matter references are rejected;
- public-research capability is rejected;
- provider citations are rejected while public research is disabled;
- audit records do not retain the synthetic matter text.

## Promotion boundary

A green CI for this candidate is not authorization to deploy it or to process a real matter.

The next promotion step after CI is an isolated synthetic staging deployment or equivalent controlled vertical E2E using dedicated staging identity/configuration. The role binding is deliberately conservative: only the Central role `lawyer`, which is verified by the canonical user-sync contract, is recognized; no broader role is inferred. Real client data remains a separate explicit authorization gate.


## SAN staging evidence snapshot

The runtime now vendors the exact staging-evidence schema from:

- SAN source commit: `111831ab2f89699bf7ea9414547b80edee8e2771`;
- schema blob: `ccaabc6c68d36652109b49ce0284c2c4af63053b`;
- snapshot: `central-legal-agent-staging-runtime/SNAPSHOT.json`.

After a successful synthetic execution, the bridge emits `san-legal-agent-staging-evidence/v1` with only bounded symbolic references and SHA-256 digests for invocation/matter/source/audit evidence. Raw matter/source text is excluded from the receipt.

The initial staging mode is deliberately stricter than the future public-research boundary: `external_research_mode=DISABLED`. SAN PR #273 explicitly permits this stricter mode.

## Railway resource blocker

A dedicated service named `central-legal-agent-staging-synthetic` was requested in the existing Central Railway project after isolated runtime certification. Railway rejected provisioning because the free-plan resource limit is already exhausted. No existing service was repurposed, deleted or modified.

Classification: `BLOCKED_RESOURCE`, not runtime failure.

Until a resource slot is available, GitHub Actions isolated runtime certification remains the executable staging environment. Real client matter authority remains false.


## Real Central session-principal binding — synthetic matter only

The next identity layer is implemented as a server-resolved principal handoff rather than forwarding a browser cookie or session token.

`dashboard-backend/central-legal-agent-session-binding.mjs` accepts only:

- identity source `CENTRAL_SERVER_SESSION`;
- `authenticated=true`;
- active Central user;
- verified role `lawyer`;
- SHA-256 principal/session references, never raw identifiers;
- explicit MFA assurance booleans, with fail-closed enforcement when MFA is required.

Raw cookie, authorization header, token, session id/token, password/hash, MFA/TOTP material or secrets are rejected if supplied to the binding object.

The `lawyer` capability set is fixed by the server-side adapter. Caller-supplied capability escalation is not accepted. The resulting invocation still uses only the bundled synthetic matter/source fixture and keeps real-matter/production authority false.

## Production identity presence preflight

The v3.2 verifier now contains an opt-in, read-only script:

`central-juridica-v32-verifier/central-lawyer-session-preflight.mjs`

When explicitly enabled, it queries only aggregate counts in `central_juridica_v32_prod_r3` inside `BEGIN READ ONLY`:

- active users with role `lawyer`;
- session rows joinable server-side to active `lawyer` users.

It emits no username, user id, session id/token/hash, password, MFA/TOTP material, database URL or row payload. Any absence of an active lawyer or joinable session fails closed. Default behavior is disabled/skipped.


## Artificial deidentified fixture technical E2E

The next privacy layer is implemented with an **artificial fixture only**.

Files:

- `dashboard-backend/central-legal-agent-deidentified-pilot.mjs`
- `dashboard-backend/test-central-legal-agent-deidentified-pilot.mjs`
- `dashboard-backend/san-legal-agent-deidentified-pilot-v1.schema.json`

The fixture deliberately contains fake structured identifiers in its source form and replaces them with bounded placeholders before the staging bridge is invoked.

The technical E2E proves:

- CNJ/CPF/CNPJ/email/phone/CEP patterns are absent from the redacted payload;
- source and redacted digests differ;
- placeholder evidence is present;
- raw source is never sent to the Legal Agent transport;
- web research/files/PJe-Calc/filing remain disabled;
- only the redacted artificial text reaches the existing staging bridge;
- real source authority, real matter authority and production authority remain false.

Automated CI uses `attestationKind=TEST_ONLY_SYNTHETIC_REVIEW`. This is deliberately marked `technicalE2EOnly=true` and `humanReviewAuthority=false`.

A real pilot must still provide `attestationKind=REAL_HUMAN_LAWYER_REVIEW`. CI is not allowed to synthesize or claim that human review.


## Server-bound human-review attestation contract

The technical E2E remains explicitly non-human and cannot promote itself into a real
review. For a future real human review of the **artificial fixture**, the pilot
adapter now requires the review attestation to be bound to a Central principal
resolved server-side through `CENTRAL_SERVER_SESSION`.

The real-review path requires:

- `attestationKind=REAL_HUMAN_LAWYER_REVIEW`;
- `attestationSource=CENTRAL_SERVER_REVIEW_EVENT`;
- SHA-256 review-event, reviewer-principal and reviewer-session digests;
- the review target digest to equal the exact artificial redacted fixture;
- active/authenticated Central role `lawyer`;
- MFA assurance when required;
- the reviewer principal/session digests to match the server-resolved binding;
- no raw cookie, authorization header, session token, password, MFA/TOTP or secret material.

Automated CI exercises only fail-closed rejection conditions for this real-review
path. It does **not** synthesize a successful `REAL_HUMAN_LAWYER_REVIEW` event
and therefore cannot grant `humanReviewAuthority=true` by itself.

This contract still grants no real-source, real-matter or production authority.
