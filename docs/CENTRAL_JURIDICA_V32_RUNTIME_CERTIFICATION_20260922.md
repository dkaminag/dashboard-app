# Central Jurídica v3.2 — production DR gate — 2026-09-22

## Scope

This gate hardens the non-canonical v3.2 Railway candidate so an encrypted DR drill cannot be accepted while the runtime is using the development audit-key fallback.

Current release baseline:

- certified main before this hardening delta: `15f88f533c6c386f274da79b435418f64a27fc3e`;
- application hardening commit: `133f5bc47aacd03b4e2233e54c9d2e8434f72554`;
- exact application delta: one file, `central-juridica-railway-v3.2.0/final-drill.mjs`;
- current Docker package pin remains `534b2a2e5c87125f9c77b27a915463d4daeaa229`;
- package path remains `central-juridica-railway-v3.2.0`.

The Dockerfile is intentionally not repinned by this PR. This is a source-level guard first; live deployment remains blocked on authoritative production audit-key recovery.

## Security finding

A bounded source diagnostic proved that `PostgresStateStore` always initializes its audit keyring through `loadAuditKeyring()`.

The keyring parser:

1. uses `CJ_AUDIT_KEYRING` when present;
2. otherwise accepts the legacy `CJ_AUDIT_KEY`;
3. fails closed when `CJ_ENV=production` and neither is available;
4. otherwise creates a deterministic development key with key id `development-v1`.

Therefore earlier green candidate DR evidence is supporting runtime evidence only. It is not sufficient production DR acceptance because the candidate had not yet been proven to run with production keyring enforcement.

Railway was subsequently hardened by explicitly setting candidate `CJ_ENV=production`. A controlled redeploy then failed closed with:

`Modo production exige CJ_AUDIT_KEYRING ou CJ_AUDIT_KEY.`

Reference-variable attempts to reuse the rollback service's keyring did not resolve a usable production audit keyring.

Earlier restore diagnostics also proved that the historical audit chain contains metadata/entries under key id `audit-2026-09`. Missing that key produced `KEY_NOT_FOUND` / `META_KEY_NOT_FOUND`. A new random key cannot validate the historical HMAC chain and must not be substituted for the original key.

## Code hardening

`final-drill.mjs` now requires:

`CJ_ENV === 'production'`

before opening either source or DR database. Otherwise it stops with:

`FINAL_DR_REQUIRES_PRODUCTION_ENV`

The deterministic source certification pins this invariant in addition to the existing fail-closed checks:

- `FINAL_DR_SOURCE_TARGET_NOT_ISOLATED`;
- `FINAL_DR_BACKUP_VERIFY_FAILED`;
- `FINAL_DR_SEMANTIC_FINGERPRINT_MISMATCH`;
- `FINAL_DR_SESSIONS_RESTORED`;
- `FINAL_KEY_BACKUP_RESTORE_VERIFIED`.

This prevents a future DR PASS from silently relying on the development audit-key fallback.

## Evidence that remains valid

The dedicated source/build certification and isolated intake verifier remain valid independent evidence:

- exact immutable v3.2 package/build certification;
- reconstructed `3.2.0-preview` runtime;
- health/readiness behavior;
- unauthenticated intake rejection;
- authenticated intake creation;
- idempotent replay;
- source/target DR separation mechanics.

Those checks do not prove possession of the historical production audit key.

## Current release blocker

Production DR acceptance remains **BLOCKED / HUMAN_OR_SECRET_CONFIGURATION** until the authoritative secret source restores the historical audit key material required for key id `audit-2026-09`.

The secret must be restored through Railway/shared-variable/original secret authority without copying the value into GitHub, chat, SAN state or logs.

Do not:

- revert `CJ_ENV` to development/non-production;
- generate a replacement key and call it `audit-2026-09`;
- reset or rebaseline the existing audit chain merely to make restore pass;
- repoint the canonical domain before production DR acceptance;
- remove the v3.1.1 rollback baseline.

## Promotion sequence

After authoritative key recovery:

1. repin the candidate Dockerfile to an exact commit containing this production-only DR guard;
2. run the deterministic source/build certification;
3. run exactly one candidate deployment under `CJ_ENV=production`;
4. require encrypted DR restore + historical audit verification + source/target separation + zero restored sessions;
5. require health/readiness PASS;
6. run the isolated verifier and require 401 → 201 → replay 200;
7. only then make a separate canonical-domain/cutover decision.
