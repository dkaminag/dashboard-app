# Central Jurídica v3.2 — current release certification — 2026-09-22

## Scope

This gate certifies the current non-canonical v3.2 Railway candidate source lineage without changing the canonical domain or the 3.1.1 rollback baseline.

- certified runtime/verifier base: `498e8348b65eb5c1a1763596b4415328877e255c`
- current release source snapshot: `67c9a14416dac1007116ae858c1b314159897b71`
- exact delta: two commits / two files
- current Docker package pin: `534b2a2e5c87125f9c77b27a915463d4daeaa229`
- package path: `central-juridica-railway-v3.2.0`

Expected release-only delta:

- `dashboard-backend/Dockerfile.central-juridica-v32-preview`
- `dashboard-backend/CJ_V32_SOURCE_REFRESH_2026-09-22.txt`

The refresh marker has no runtime behavior. The Dockerfile must keep an immutable commit pin and must not regress to the historical v3.1.1 wrapper path.

## Deterministic source/build gate

The certification workflow must:

1. prove the exact two-commit/two-file lineage above;
2. prove the certification branch does not alter the candidate package, Dockerfile or verifier relative to the source snapshot;
3. retain the nine-part overlay transport hash;
4. rebuild the reconstructed `3.2.0-preview` runtime;
5. validate intake modules, OpenAPI contract and fail-closed DR invariants;
6. validate the isolated verifier package;
7. build the Railway Docker candidate from the immutable source pin;
8. avoid Railway secrets and production database mutation during source/build certification.

## Live runtime evidence

Live acceptance is separate from source/build certification.

The existing non-canonical Railway service `central-juridica-v3-1-1` has already demonstrated health/readiness plus authenticated intake and idempotent replay. On 2026-09-22 the current-source DR attempt initially failed closed with `FINAL_DR_SOURCE_TARGET_NOT_ISOLATED`, proving the configured DR target was not isolated.

A dedicated Neon branch `cj-dr-verification-20260922` was then created under the v3.2 Neon project and configured only as `CJ_DR_DATABASE_URL`. The next in-place candidate deployment produced `FINAL_KEY_BACKUP_RESTORE_VERIFIED` with `sourceTargetSeparated=true`, `sessionsRestored=0` and matching semantic fingerprint, then passed `/api/ready`.

The existing isolated verifier has independently proven health 200, ready 200, unauthorized intake 401, successful intake and idempotent replay.

## Promotion boundary

This evidence does not itself repoint a canonical domain, remove the 3.1.1 rollback baseline, or authorize destructive cleanup of the DR branch. Those actions remain separate promotion/cleanup decisions.
