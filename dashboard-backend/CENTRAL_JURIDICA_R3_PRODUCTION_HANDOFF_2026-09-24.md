# Central Jurídica v3.2 R3 — Production Handoff
Date: 2026-09-24

## Final status
DELIVERED / OPERATIONAL / GO-LIVE READY

Public URL:
https://central-juridica-v3-2-prod-production.up.railway.app

## Active production
- Railway project: central-juridica-brito-peovezan
- service: central-juridica-v3-2-prod
- deployment: b058e166-3271-4e6d-a917-69441c25df98
- snapshot: 067be727-1fc7-431b-88fc-35a1b25fcb66
- wrapper commit: f23e532876b35cfa83677966b463c765a807ed8c
- admin-first commit: 1b93b69d0d6148d9f35f92c6025d13cd2cedaed9
- immutable runtime pin: d507a9955be07ef710d410b5263686ac75caeeff
- app version: 3.2.0-preview

## Active R3 databases
- primary: central_juridica_v32_prod_r3
- DR: central_juridica_v32_dr_r3

Preserved rollback lineages:
- central_juridica_v32_prod_r2
- central_juridica_v32_dr_r2
- central_juridica_v32_prod
- central_juridica_v32_dr

No destructive deletion was performed.

## R3 two-stage bootstrap
1. Admin-first deployment:
   - QA deferred
   - DR drill restoredUsers=0
   - runtime started and native admin bootstrap executed
   - /api/ready=200
2. Admin+QA deployment:
   - QA synthetic account created
   - final DR drill restoredUsers=2
   - restoredAuditEntries=2
   - sessionsRestored=0
   - primary/DR separated

## Least privilege
Runtime role: central_juridica_v32_runtime
- superuser=false
- createdb=false
- createrole=false
- replication=false
- bypassrls=false

## DR gate
FINAL_KEY_BACKUP_RESTORE_VERIFIED = PASS
- manifestVersion=3
- backupKeyIdPresent=true
- sourceTargetSeparated=true
- restoredUsers=2
- restoredAuditEntries=2
- restoredDocuments=0
- sessionsRestored=0
- semanticFingerprint=5692fea0722daa8a65ccc3f24aee358b9ec6f705676ebfff416e67caa1b039bf

## Final smoke
Verifier:
- deployment: 77afee18-d0c5-4e8c-a33f-ff5d950c29b1
- commit: 9a50ab707852e762f7e25991eddba39da5924f66
- status: SUCCESS

Validated:
- UI=200 / valid HTML
- health=200
- ready=200
- unauthenticated dashboard=401
- QA login=200
- QA session=200
- QA dashboard=200
- QA logout=200
- stale session=401
- unauthenticated intake=401
- authenticated intake=201
- idempotent replay=200 / replayed=true
- admin login=PASS
- admin session=200

## Mandatory MFA
The administrative account is intentionally fail-closed until the human administrator enrolls MFA.

Pre-enrollment:
- /api/audit/gates=403
- confirmed reason: mandatory MFA activation for this profile

This is an approved security control, not an application defect.

MFA enrollment was deliberately not automated because the TOTP seed and recovery codes must remain under the human administrator's control.

## Key material
Cryptographic secret values are intentionally excluded from this document.

Active key IDs:
- audit-2026-09-r2
- backup-2026-09-r2
- document-2026-09-r2
- mfa-2026-09-r2

The R3 cutover preserved the R2 cryptographic era while moving to new R3 databases.

## Deployment source controls
Production watch patterns now include:
- Dockerfile.central-juridica-v32-isolated
- prepare-central-juridica-v32-isolated.mjs
- start-central-juridica-v32-isolated.mjs
- patch-central-juridica-v32-runtime-least-privilege.mjs
- central-juridica-v32-isolated-trigger/**

This prevents stale-source wrapper redeploys.

## Custom domain
No institutional custom domain is configured.
The Railway-managed HTTPS domain is live.

## External integrations
Google/AI/SAN integrations require their own live gate before use with real legal data. They are not required for the approved core production cutover.

## Operational classification
- core deployed: PASS
- public HTTPS: PASS
- UI: PASS
- auth/session/logout: PASS
- intake/idempotency: PASS
- primary PostgreSQL: PASS
- isolated DR: PASS
- backup/restore: PASS
- least privilege: PASS
- human admin exists/login works: PASS
- mandatory admin MFA enforcement: PASS
- human MFA enrollment: FIRST-LOGIN ACTION REQUIRED
- destructive rollback risk introduced: NO

The R3 release is the canonical operational baseline.
