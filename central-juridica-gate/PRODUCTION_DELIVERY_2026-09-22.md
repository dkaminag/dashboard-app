# Central Jurídica — Entrega operacional — 2026-09-22

## Runtime operacional

- Plataforma: Railway
- Projeto: central-juridica-brito-peovezan
- Serviço operacional: central-juridica-v3-1-1
- Runtime observado: 3.2.0-preview
- Endpoint HTTPS: https://central-juridica-v3-1-1-production.up.railway.app
- Deployment saudável em serviço: 18dbd963-e00e-4bae-9adc-ab09d7eb5052
- Source commit associado ao snapshot: 15f88f533c6c386f274da79b435418f64a27fc3e
- Estado observado: SUCCESS

O Railway continuou roteando tráfego ao deployment saudável quando tentativas posteriores de redeploy falharam em modo fail-closed por ausência de keyring no novo snapshot. Nenhum keyring foi regenerado ou sobrescrito.

## Provas live

- server-listening version=3.2.0-preview
- /api/health = 200
- /api/ready = 200
- POST /api/intake/leads sem credencial = 401
- primeira ingestão autorizada = 201/200
- replay com mesma Idempotency-Key = 200 e replayed=true
- FINAL_KEY_BACKUP_RESTORE_VERIFIED passed=true
- DR source/target separados
- backup manifest version 3
- sessionsRestored=0

## Verifier

- Serviço: central-juridica-cutover-smoke-verifier
- Deployment final de verificação: 8d04c91d-a4eb-49a2-959b-8ee8d0e97f6b
- Estado: SUCCESS
- Resultado: CENTRAL_JURIDICA_V32_INTAKE_E2E passed=true
- version=3.2.0-preview
- health=200
- ready=200
- unauth=401
- replayed=true

Configuração restaurada:
- startCommand: npm start
- preDeployCommand: node smoke.mjs

## Gate acumulado

- Run: 35446121377
- Job: 105905223226
- Commit: 0e2d867fb3d0355174123d5fb6c7bc603cc4d181
- Resultado: SUCCESS
- Evidence artifact: 10585093961
- Evidence SHA-256: ff0b7a8a73c64b993a0db2aa35fcfb4b4f7074933d61ef6e50b6696c2b4f7d15

Inclui gates v1.5 até v3.2, documentos dedicados, clientes dedicados, Central Sheet e final production readiness.

## Artefato de rollback certificado

- Workflow run: 35733265073
- Artifact: 10695658298
- Artifact SHA-256: fb57cf78ddfb9fcee608a9e3ed0c871bc1717e2ba7b8f2c3a6fc4859a96622e5
- Pacote interno: central-juridica-production-v3.1.1-certified.zip
- Pacote interno SHA-256: 75c596562af4aa0eb649ac1492b687fc10b5685b3387d435884c756b9375615a

## Pendências não bloqueantes do core

- Google app OAuth: desabilitado/opcional.
- OpenAI app integration: desabilitada/opcional.
- PostgreSQL driver: fixar explicitamente sslmode=verify-full antes do upgrade para pg v9.
- O serviço histórico central-juridica-v3-1-1-cutover possui tentativas recentes FAILED; rollback administrativo ao snapshot anterior requer Railway deploymentRollback, não exposto pelo conector OAuth atual. O runtime v3.2 operacional não foi redeployado para evitar perda de keyrings.

## Decisão

CORE_RUNTIME_OPERATIONAL = true
LIVE_E2E = PASS
DR_GATE = PASS
ACCUMULATED_DB_GATE = PASS
ROLLBACK_ARTIFACT = VERIFIED
OPTIONAL_GOOGLE_OPENAI = DISABLED
