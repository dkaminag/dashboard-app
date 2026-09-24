# Central Jurídica v3.2 R3 — redeploy recovery note — 2026-09-24

## Operational truth

The canonical live R3 runtime remains the successful Railway deployment:

- service: `central-juridica-v3-2-prod`
- deployment: `b058e166-3271-4e6d-a917-69441c25df98`
- source commit: `f23e532876b35cfa83677966b463c765a807ed8c`
- primary database: `central_juridica_v32_prod_r3`
- DR database: `central_juridica_v32_dr_r3`
- version: `3.2.0-preview`

Fresh verifier evidence after later failed deployment attempts continued to return UI/health/readiness/auth/intake/idempotency PASS. Railway keeps the last successful deployment serving traffic when a subsequent predeploy fails.

## Why recent redeploy attempts failed

Railway `redeploy` re-runs the latest deployment snapshot and does not fetch the current GitHub head. The attempted redeploys reused stale source commit `ca6577def68fd58ecf0c62e937fbc3a7ebc5549d`, whose predeploy targets the older non-R3 databases `central_juridica_v32_prod` / `central_juridica_v32_dr`.

Those older databases contain audit history whose metadata references `audit-2026-09-prod`. Current keyrings do not expose that historical key id, so the fail-closed audit verifier correctly blocks restore. Creating a replacement key for that id is prohibited because it would not authenticate the existing HMAC chain.

This is not evidence that the live R3 deployment is unhealthy.

## Keyring recovery findings

The runtime keyring contract is strict JSON:

`{activeKeyId, legacyKeyId, keys: {keyId: base64url32}}`

Tests against existing single-key variables showed:
- the v3.2 single `CJ_AUDIT_KEY` is a valid 32-byte key but does not authenticate the older `audit-2026-09-prod` chain;
- the legacy v3.1.1/cutover single-key references are not valid candidates for that historical id;
- existing keyrings do not currently expose `audit-2026-09-prod`.

The v3.2 `CJ_AUDIT_KEYRING` configuration has been restored to the governed verifier keyring reference used by the R3 line. No secret values are stored in Git or this document.

## Safe next deployment

Do not use Railway `redeploy` to recertify R3.

The next v3.2 deployment must deploy a current GitHub commit (at or after the R3 wrapper) through Railway's source-deploy path / `serviceInstanceDeployV2(commitSha)`, or the Railway dashboard's deploy-current-source action.

Before canonical routing changes:
1. source commit must target the R3 databases;
2. predeploy DR drill must PASS;
3. readiness must be 200;
4. combined verifier must PASS;
5. existing canonical traffic must remain unchanged until explicit cutover approval.

No security or audit gate should be weakened to obtain a green deployment.
