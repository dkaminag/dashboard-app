# Central Jurídica v3.2 — Controlled Admin Credential Resync

Date: 2026-09-28  
Scope: canonical Central Jurídica v3.2 administrator credential synchronization  
Classification: **COMPLETED / AUDITED / MFA PRESERVED / SESSIONS REVOKED**

## Authorization

Human authorization was received to perform a controlled resynchronization of the Central Jurídica v3.2 administrator credential with the following constraints:

- preserve the existing administrator profile;
- preserve the existing MFA/TOTP enrollment and key material;
- revoke all persisted administrator sessions;
- append an auditable event;
- do not expose any credential or MFA secret.

## Canonical target

Railway project:

- `central-juridica-brito-peovezan`
- project_id: `3bea1a5c-b620-4680-96bb-9312e3d69567`

Canonical service:

- `central-juridica-v3-2-prod`
- service_id: `f4088039-0043-4d2e-be9d-e376f249bf76`
- source commit remained: `d76a2dbf257853d495c177f7930c20c5ce5278bc`

Canonical database:

- Neon project: `little-butterfly-23082309`
- branch: `br-misty-darkness-aydj2mqf`
- database: `central_juridica_v32_prod_r3`

## Execution boundary

The write was executed only by the isolated verifier service:

- `central-juridica-cutover-smoke-verifier`
- service_id: `bb1a9b97-d848-4728-9471-0275fbe6112f`

Credential authority remained provider-side through Railway reference variables to the canonical service.

No password value, MFA seed, recovery code, database credential, keyring value or session token was copied into GitHub, chat, logs or documentation.

## One-shot operation

Maintenance script:

- `central-juridica-v32-verifier/admin-credential-resync.mjs`

Fresh nonce:

- `admin-resync-20260928-controlled-02`

Verifier pre-deploy chain for the operation:

```text
audit-keyring-canary.mjs
→ admin-credential-resync.mjs
→ smoke.mjs
```

Smoke mode:

- `intake-only`

Operation deployment:

- `566b0d18-1d18-4f74-8b47-67e3c0c7ffb3`
- status: **SUCCESS**

## Canonical database evidence

Audit event:

- sequence_id: `109`
- entry_id: `audit_be40ea16-eb56-43c7-9d0d-977bada23459`
- action: `ADMIN_CREDENTIAL_RESYNCED`
- requestId: `admin_resync_admin-resync-20260928-controlled-02`

Verified event fields:

```text
controlled=true
providerSecretAuthority=true
previousPasswordMatched=true
passwordRehashed=true
sessionsBefore=0
sessionsRevoked=0
sessionsAfter=0
nonPasswordStatePreserved=true
mfaKeyMaterialTouched=false
```

Interpretation:

- the canonical provider credential already matched the persisted administrator credential;
- the password was deliberately re-hashed/resynchronized;
- the session revocation operation executed;
- there were no persisted administrator sessions at execution time;
- final persisted administrator session count is zero;
- all non-password account state was preserved;
- MFA/TOTP key material was not touched.

Current administrator invariants after the operation:

- account active: true;
- password hash present: true;
- password changed timestamp present: true;
- MFA/TOTP profile fields present: true;
- administrator sessions: 0.

## One-shot cleanup

Immediately after successful resynchronization:

- `CJ_ADMIN_CREDENTIAL_RESYNC` was reset to `false`;
- `CJ_ADMIN_CREDENTIAL_RESYNC_NONCE` was cleared;
- `CJ_QA_SMOKE_MODE` remained `intake-only`;
- verifier pre-deploy was restored to:

```text
audit-keyring-canary.mjs
→ smoke.mjs
```

Cleanup verifier deployment:

- `0d85856f-3609-4bf1-8626-a95f0fc4a837`
- status: **SUCCESS**

Current verifier configuration confirms the maintenance script is no longer in the pre-deploy chain.

## Canonical runtime reload

A same-source reload of the canonical Central v3.2 service was performed to eliminate any possible stale in-memory authentication state.

Canonical reload deployment:

- `b587d7bb-3890-40c4-9fd3-f0846acdca5c`
- status: **SUCCESS**
- source commit unchanged: `d76a2dbf257853d495c177f7930c20c5ce5278bc`

Pre-deploy evidence:

- primary DB: `central_juridica_v32_prod_r3`;
- DR DB: `central_juridica_v32_dr_r3`;
- runtime role: `central_juridica_v32_runtime`;
- runtime role superuser: false;
- createdb: false;
- createrole: false;
- replication: false;
- bypassrls: false;
- `FINAL_KEY_BACKUP_RESTORE_VERIFIED`: passed=true;
- sourceTargetSeparated=true;
- sessionsRestored=0;
- `isolated-prod-predeploy-passed`: PASS.

Final datastore verification after canonical reload:

- audit event still present: true;
- administrator sessions: 0;
- administrator active: true;
- MFA profile present: true.

## Final classification

- controlled admin credential resynchronization: **PASS**
- provider credential verified against existing hash: **PASS**
- password rehashed: **PASS**
- administrator session revocation operation: **PASS**
- administrator sessions after maintenance: **0**
- non-password profile state preserved: **PASS**
- MFA key material modified: **NO**
- MFA profile still present: **YES**
- audit event appended: **PASS**
- one-shot left enabled: **NO**
- verifier cleanup: **PASS**
- canonical same-source reload: **PASS**
- canonical v3.2 deployment changed in source/config: **NO**
- secrets exposed: **NO**

The next administrator login must continue to use the existing MFA second factor.
