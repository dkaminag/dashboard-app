# Central Jurídica v3.2 R2 — Production Handoff
Date: 2026-09-24

## Status
CORE_PRODUCTION_READY / PRODUÇÃO INICIAL CONTROLADA

## Production
- Railway project: central-juridica-brito-peovezan
- Service: central-juridica-v3-2-prod
- Deployment: cc415490-059e-430f-97a9-5fde1391e16a
- Snapshot: 677507fa-5a61-4ea7-9b10-316217088d35
- Public URL: https://central-juridica-v3-2-prod-production.up.railway.app
- Cutover commit: b2012d741af91d61b7b66624105694974e0b2ce6
- Immutable runtime pin: d507a9955be07ef710d410b5263686ac75caeeff
- Version: 3.2.0-preview

## Databases
Active:
- primary: central_juridica_v32_prod_r2
- DR: central_juridica_v32_dr_r2

Preserved rollback lineage:
- central_juridica_v32_prod
- central_juridica_v32_dr
- prior green deployment: 8add1157-a771-460c-90ea-9e6a7f769477

No destructive deletion was performed.

## Runtime least privilege
Role central_juridica_v32_runtime:
- superuser=false
- createdb=false
- createrole=false
- replication=false
- bypassrls=false

## Cryptographic key IDs
Secret values are intentionally omitted.
- audit-2026-09-r2
- backup-2026-09-r2
- document-2026-09-r2
- mfa-2026-09-r2

## DR drill
FINAL_KEY_BACKUP_RESTORE_VERIFIED = PASS
- sourceTargetSeparated=true
- manifestVersion=3
- backupKeyIdPresent=true
- documents=0
- restoredDocuments=0
- restoredUsers=1
- restoredAuditEntries=1
- sessionsRestored=0
- semanticFingerprint=5cbb472a1c31c2f006d7aab91111bd44d592b89282eaf71b9225fc5ef725a676

## Fresh-source production smoke
Verifier deployment: 38e08a10-6d15-47ef-99f7-de05cf03f562
Verifier commit: c8b9183abf5eb0d56345ad0f0d61ddd998597e76
Result: SUCCESS
- UI=200
- UI HTML=true
- health=200
- ready=200
- unauth dashboard=401
- login=200
- session=200
- authenticated dashboard=200
- logout=200
- stale session=401
- unauth intake=401
- first authenticated intake=201
- idempotent replay=200
- replayed=true

## Deployment configuration
The production service now watches the Dockerfile, prepare/start wrappers, least-privilege patch and trigger directory. This prevents stale-source redeploys when deployment wrappers change.

## Operational handoff
- Credentials/tokens/key material remain only in provider secrets.
- Use individual human accounts and MFA.
- Do not mix R2 key material with the preserved historical databases.
- Restore to a separated target before DR promotion.
- Google/AI/SAN integrations require their own live gate before real legal data is sent to them.
- No custom institutional domain is configured; the Railway HTTPS domain is live.

## Final classification
Application delivered and running: YES
Core production initial controlled use: APPROVED
Custom domain: optional / not configured
External AI/Google live integrations: not part of this core cutover gate
