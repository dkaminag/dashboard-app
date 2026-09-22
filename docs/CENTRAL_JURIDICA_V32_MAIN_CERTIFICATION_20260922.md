# Central Jurídica v3.2 — main certification plan — 2026-09-22

## Scope

This gate certifies the current `main` source snapshot for the v3.2 preview package without mutating Railway production services.

Source snapshot under test:

- repository: `dkaminag/dashboard-app`
- base before narrowed delta: `e844ca9b1ef15500971daba024c33e2cd15fd054`
- source snapshot: `42aeae42db77ac2f4ad964ad1415df2539943b1c`
- narrowed delta: exactly two commits
- expected application-file delta:
  - `central-juridica-railway-v3.2.0/intake-e2e-smoke.mjs`
  - `dashboard-backend/Dockerfile.central-juridica-v32-preview`

## Certification boundary

The workflow must prove:

1. the two-commit source delta remains exactly the expected two files;
2. the certification branch does not modify v3.2 application source relative to the source snapshot;
3. the packaged v3.2 overlay reconstructs successfully and retains its pinned transport hash;
4. the reconstructed runtime has the expected intake modules and OpenAPI contract;
5. the E2E intake verifier is syntactically valid;
6. the Railway Docker candidate still fetches an immutable Git commit, not a mutable branch;
7. the Docker candidate builds on a clean hosted Linux runner.

This is source/build certification only. It does not prove Railway runtime secrets, Neon/DR behavior, live intake, or production readiness.

## In-place Railway plan after PASS

Do not create a new Railway service. Reuse the existing services only after the exact-head source/build gate passes.

- keep `central-juridica-v3-1-1-cutover` as the 3.1.1 rollback baseline until v3.2 acceptance closes;
- use the existing non-canonical `central-juridica-v3-1-1` service as the isolated v3.2 runtime candidate only if its required production-mode keyrings and database references are present through governed Railway variables;
- use the existing `central-juridica-cutover-smoke-verifier` as the v3.2 intake verifier, bound to the exact candidate endpoint and token;
- no secret values are copied into GitHub, chat or repository state;
- do not repoint the canonical cutover domain or remove the 3.1.1 rollback baseline until runtime smoke, idempotent replay and DR/readiness evidence pass.

## Known runtime blocker

Current Railway evidence shows the isolated v3.2 candidate/verifier fails closed in production mode when the audit keyring is unavailable:

`Modo production exige CJ_AUDIT_KEYRING ou CJ_AUDIT_KEY.`

That is a secret/configuration blocker, not a source-build certification failure. It must be resolved through Railway variable configuration rather than by weakening the runtime check.
