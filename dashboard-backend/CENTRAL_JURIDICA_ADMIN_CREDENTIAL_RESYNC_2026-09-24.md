# Central Jurídica v3.2 — Controlled Admin Credential Resync

Date: 2026-09-24  
Scope: canonical Central Jurídica v3.2 administrator credential synchronization  
Classification: completed / audited / MFA preserved

## Authorization

Human authorization was received to perform a controlled administrative credential resynchronization while:

- preserving the existing MFA enrollment and key material;
- revoking previously persisted administrative sessions;
- avoiding secret disclosure.

## Canonical target

Railway project:
- `central-juridica-brito-peovezan`

Canonical service:
- `central-juridica-v3-2-prod`
- service ID: `f4088039-0043-4d2e-be9d-e376f249bf76`
- canonical deployment remained:
  `b9a7d051-9917-4aff-b2d2-7e3c1b8a0a7d`
- source commit:
  `d76a2dbf257853d495c177f7930c20c5ce5278bc`

The canonical service was not redeployed or reconfigured by this maintenance.

## Execution boundary

The one-shot operation was executed through the isolated service:

- `central-juridica-cutover-smoke-verifier`
- service ID: `bb1a9b97-d848-4728-9471-0275fbe6112f`

No credential value was copied into GitHub, documentation, chat, or logs.

Credential authority was supplied through Railway reference variables pointing to the canonical v3.2 service.

## One-shot implementation

Maintenance script:
- `central-juridica-v32-verifier/admin-credential-resync.mjs`

Initial implementation commit:
- `8ef65c88e402b4a61d5e79c0255e597e216c384b`

Canonical-reference hardening commit:
- `61b77751df67444c91c3739e5a7eb83a64c9c4ff`

The script is fail-closed and requires an explicit one-shot flag and nonce.

Its transaction:

1. locks the existing administrator record;
2. verifies the account already exists and is active;
3. preserves every non-password field;
4. hashes the canonical provider-side password;
5. updates only password-related timestamps/hash plus the record update timestamp;
6. deletes all sessions belonging to the exact administrator user ID;
7. verifies the canonical password against the persisted hash;
8. verifies non-password state is unchanged;
9. appends an audit-chain event;
10. commits atomically.

It does not create a new administrator and does not modify MFA key material.

## Dry-run gate

Fresh-source verifier deployment:

- deployment: `912183d4-8a25-40eb-b0fd-f1cc1fe2211b`
- source commit: `542fdc7663803daee9d31c7ec4c1173dc5ef449d`

Evidence:

- verifier build included `admin-credential-resync.mjs`;
- syntax check: PASS;
- audit keyring canary: PASS;
- `ADMIN_CREDENTIAL_RESYNC_SKIPPED` with enabled=false;
- combined smoke: PASS;
- UI=200;
- health=200;
- ready=200;
- unauth dashboard=401;
- unauth intake=401;
- intake=201;
- replay=200 / replayed=true.

## Controlled resynchronization

Operation deployment:

- deployment: `0ec6d69b-15fd-4e02-a6f4-385667663e47`
- source commit: `61b77751df67444c91c3739e5a7eb83a64c9c4ff`
- nonce: `admin-resync-20260924-controlled-01`

Audit keyring canary before the write:

- passed=true;
- historical key present=true;
- audit-chain errors=[].

One-shot result:

```text
ADMIN_CREDENTIAL_RESYNC_COMPLETE
passed=true
previousPasswordMatched=true
passwordVerified=true
passwordRehashed=true
sessionsBefore=0
sessionsRevoked=0
sessionsAfter=0
nonPasswordStatePreserved=true
mfaKeyMaterialTouched=false
credentialAuthority=canonical-service-reference
```

Interpretation:

- the canonical provider credential already matched the stored administrator credential before rehash;
- the credential was nevertheless deliberately rehashed/resynchronized;
- no persisted administrator sessions existed at execution time;
- the session revocation operation ran and the final persisted session count is zero;
- all non-password account state was preserved;
- MFA key material was not touched.

An `ADMIN_CREDENTIAL_RESYNCED` entry was appended to the audit chain.

## MFA behavior

After the transaction, the verifier's legacy full smoke attempted a password-only administrator login and failed because the administrator is MFA-enrolled.

This caused the operation deployment itself to be marked FAILED after the database transaction had already completed.

That post-transaction verifier failure is not a credential-resync failure. It is consistent with the R3 security boundary that prohibits password-only automated administrator verification after human MFA enrollment.

No MFA reset, bypass, seed regeneration, recovery-code regeneration, or enrollment change was performed.

## Cleanup and final verifier state

Immediately after the one-shot:

- `CJ_ADMIN_CREDENTIAL_RESYNC` returned to false;
- verifier pre-deploy command was restored to:
  `audit-keyring-canary.mjs → smoke.mjs`;
- verifier smoke mode was fixed to `intake-only`.

Clean final deployment:

- deployment: `0e66de7f-39b8-40ef-9660-ccc34d8b581b`
- source commit: `61b77751df67444c91c3739e5a7eb83a64c9c4ff`
- status: SUCCESS.

Final evidence:

- audit keyring canary: PASS;
- health=200;
- ready=200;
- UI=200;
- unauth dashboard=401;
- unauth intake=401;
- first intake=201;
- replay=200 / replayed=true;
- smokeMode=intake-only.

Verifier pre-deploy command was confirmed restored after the successful cleanup deployment.

## Final classification

- canonical admin credential synchronized: PASS;
- provider credential verified against persisted hash: PASS;
- password rehashed: PASS;
- persisted admin sessions after maintenance: 0;
- non-password administrator state preserved: PASS;
- MFA key material modified: NO;
- canonical v3.2 deployment changed: NO;
- canonical service health/readiness after operation: PASS;
- secrets exposed: NO;
- one-shot left enabled: NO.

The next human administrator login must continue to use the existing MFA second factor.


## Post-resync canonical reload and cleanup verification

A same-source canonical service redeploy was performed after the controlled transaction to eliminate any possibility that a long-lived process retained stale in-memory authentication state.

Canonical reload deployment:

- service: `central-juridica-v3-2-prod`;
- deployment: `68914108-71b3-4c3b-aad9-86f17a92ea5f`;
- status: **SUCCESS**;
- source/config release remained the existing R3 runtime;
- primary database: `central_juridica_v32_prod_r3`;
- DR database: `central_juridica_v32_dr_r3`;
- least-privilege runtime role verification: PASS on both databases;
- `FINAL_KEY_BACKUP_RESTORE_VERIFIED`: PASS;
- source/target separation: PASS;
- sessions restored by DR: 0;
- `isolated-prod-predeploy-passed`: PASS;
- server started as `3.2.0-preview`;
- `/api/ready`: 200.

The subsequent password-only admin smoke continued to return 401. This does not invalidate the credential resynchronization: the controlled transaction already proved the canonical provider password against the persisted hash, and the administrator's existing MFA state was deliberately preserved. Password-only automated admin verification is therefore not a valid replacement for the protected human MFA challenge.

Final verifier cleanup was re-applied explicitly:

- `CJ_ADMIN_CREDENTIAL_RESYNC=false`;
- `CJ_QA_SMOKE_MODE=intake-only`;
- pre-deploy chain restored to `audit-keyring-canary.mjs → smoke.mjs`;
- cleanup deployment: `0e87c8e0-7fdf-4074-834c-53f643b2cdfa`;
- cleanup status: **SUCCESS**;
- audit-keyring canary: PASS;
- UI/health/readiness: 200/200/200;
- unauthenticated dashboard/intake: 401/401;
- first intake: 201;
- replay: 200 with `replayed=true`.

Final maintenance classification after reload:

- controlled credential resync: **PASS**;
- canonical runtime reload: **PASS**;
- final verifier cleanup: **PASS**;
- one-shot resync enabled: **NO**;
- MFA key material modified: **NO**;
- remaining protected action: human administrator MFA-authenticated login/challenge only.
