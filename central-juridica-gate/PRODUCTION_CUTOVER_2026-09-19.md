# Central Jurídica — Production Cutover — 2026-09-19

## Canonical hosted runtime

- Platform: Railway
- Project: central-juridica-brito-peovezan
- Service: central-juridica-v3-1-1-cutover
- Runtime version: 3.1.1
- Public HTTPS: https://central-juridica-v3-1-1-cutover-production.up.railway.app
- Current deployment: 275b74de-4b45-42ba-a49d-17907717bbff
- Deployment status: SUCCESS
- Source wrapper commit represented by Railway snapshot: c2873d550991af51a596538fdf0166ba920f8935
- Runtime transport bundle encoded SHA-256: b4cfd699b7667411fd89ed78b7766ee31e1c87f1813cb3827d2186ca456cc8f0

The Railway build configuration applies the read-only snapshot compatibility patch after unpacking the certified bundle. The persistent build command no longer includes the one-time DR drill.

## Accumulated application gate

Final accumulated delivery gate:
- GitHub Actions run: 35436022697
- Job: 105878689582
- Commit: 543e06d431616c700746d9ad45aa1fa39a5057c5
- Conclusion: SUCCESS
- Evidence artifact: 10581919875
- Evidence digest: sha256:8a576cbe3851e7d1b6a5502466776331837ff87dbd35f3f9ffcfc1b38fc6a854

The accumulated gate reports 16/16 required capabilities ready and the normalized PostgreSQL domain outside the singleton JSONB.

## Hosted post-DR smoke

- GitHub Actions run: 35446075461
- Job: 105905102903
- Commit: 65315e84cd1a3d963acdf3788765d346a3dd9e20
- Conclusion: SUCCESS
- Evidence artifact: 10585438351
- Evidence digest: sha256:4bd2b93a67cc28c31fa29d511bee82ee01dd988e1c915ecd42896b59234e16c2

Observed:
- /api/health = 200
- /api/ready = 200
- health.ok = true
- readiness probe.ok = true
- backend = postgres
- productionGuard = true
- documentsEnabled = true

The deployment pre-deploy smoke also verifies unauthenticated denial, login, authenticated session, dashboard access, logout, and stale-session rejection.

## Disaster recovery

The previous DR drill on 2026-09-17 identified PostgreSQL error 25006 because SELECT ... FOR SHARE was attempted inside a REPEATABLE READ READ ONLY snapshot transaction.

The production build now removes the incompatible FOR SHARE while retaining REPEATABLE READ MVCC snapshot consistency. A one-time isolated DR drill using the configured distinct CJ_DR_DATABASE_URL was included in the build for deployment 275b74de-4b45-42ba-a49d-17907717bbff. The build, deployment, normal authentication smoke, healthcheck, and post-DR hosted smoke all completed successfully. The DR drill was then removed from the persistent build command so future deploys do not overwrite the DR target unnecessarily.

## Integration scope

At the final hosted smoke:
- Google app integration configured/enabled: false
- OpenAI app integration configured/enabled: false
- SAN enabled: true

Google/OpenAI are optional integration phases and are not part of the core production gate. No external provider credentials are recorded in this file.

## Vercel

The former Vercel public alias is not canonical. Its latest public probe served the static marker CENTRAL_JURIDICA_V3_PUBLIC_PROBE and returned 404 for /api/health and /api/ready. Railway is the canonical runtime for this release.

## Decision

CORE_PRODUCTION_READY = true
CANONICAL_RUNTIME = Railway / v3.1.1
DELIVERY_GATE = v3.2 accumulated gate PASS
