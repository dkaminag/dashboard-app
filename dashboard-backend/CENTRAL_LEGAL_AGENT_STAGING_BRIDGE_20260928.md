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
