# Central Jurídica — Cutover canônico v3.2

**Data:** 24/09/2026  
**Status:** `CORE_CANONICAL_CUTOVER = PASS`  
**Admin humano:** `BLOCKED_CREDENTIAL_DRIFT`  
**MFA humano:** `PENDING`

## 1. URL canônica

A referência oficial da Central Jurídica passa a ser:

`https://central-juridica-v3-2-prod-production.up.railway.app`

Serviço Railway:

- projeto: `central-juridica-brito-peovezan`
- ambiente: `production`
- serviço: `central-juridica-v3-2-prod`
- service id: `f4088039-0043-4d2e-be9d-e376f249bf76`
- região: `iad`

Não existe domínio institucional customizado configurado. O domínio Railway HTTPS acima é, portanto, a referência canônica atual.

## 2. Deploy canônico aprovado

Redeploy de cutover:

- deployment: `b9a7d051-9917-4aff-b2d2-7e3c1b8a0a7d`
- snapshot: `4a6f6784-590d-4a76-87e9-4cfe91f8bdce`
- source commit: `d76a2dbf257853d495c177f7930c20c5ce5278bc`
- runtime jurídico pinado: `d507a9955be07ef710d410b5263686ac75caeeff`
- status: `SUCCESS`

Pre-deploy confirmado:

- primário: `central_juridica_v32_prod_r3`
- DR: `central_juridica_v32_dr_r3`
- runtime role: `central_juridica_v32_runtime`
- superuser: false
- createdb: false
- createrole: false
- replication: false
- bypassrls: false
- `FINAL_KEY_BACKUP_RESTORE_VERIFIED.passed = true`
- `sourceTargetSeparated = true`
- `sessionsRestored = 0`
- `isolated-prod-predeploy-passed`
- server version: `3.2.0-preview`
- `/api/ready = 200`

## 3. Referências canônicas

A própria v3.2 recebeu:

`CJ_PUBLIC_BASE_URL=https://central-juridica-v3-2-prod-production.up.railway.app`

O verifier passou a usar referências Railway para evitar duplicação/drift de secrets:

- `CJ_PREVIEW_BASE_URL=https://${{central-juridica-v3-2-prod.RAILWAY_PUBLIC_DOMAIN}}`
- `CJ_INTAKE_TOKEN=${{central-juridica-v3-2-prod.CJ_INTAKE_TOKEN}}`
- `CJ_QA_USER=${{central-juridica-v3-2-prod.CJ_QA_USER}}`
- `CJ_QA_PASSWORD=${{central-juridica-v3-2-prod.CJ_QA_PASSWORD}}`
- `CJ_ADMIN_USER=${{central-juridica-v3-2-prod.CJ_ADMIN_USER}}`
- `CJ_ADMIN_PASSWORD=${{central-juridica-v3-2-prod.CJ_ADMIN_PASSWORD}}`

Nenhum valor secreto foi lido ou copiado durante o cutover.

## 4. Smoke final do core canônico

Verifier final operacional:

- serviço: `central-juridica-cutover-smoke-verifier`
- deployment: `7fe108b5-3620-4161-88b4-6daf21c889ea`
- snapshot: `896f3403-a959-42df-ab76-f9d9ca8df3bb`
- status: `SUCCESS`
- modo operacional restaurado: `intake-only`

Resultado:

- passed: true
- version: `3.2.0-preview`
- UI: 200
- HTML válido: true
- health: 200
- ready: 200
- dashboard sem login: 401
- intake sem credencial: 401
- primeiro intake autenticado: 201
- replay idempotente: 200
- replayed: true
- syntheticIdentityUnique: true

## 5. Smoke full e gate administrativo

Foi executado adicionalmente um smoke full.

QA e core chegaram à etapa administrativa, mas o login admin retornou:

`ADMIN_LOGIN_FAILED_401`

O verifier foi então sincronizado por **reference variables** diretamente com `CJ_ADMIN_USER` e `CJ_ADMIN_PASSWORD` da v3.2 e o teste foi repetido.

Resultado permaneceu:

`ADMIN_LOGIN_FAILED_401`

Conclusão:

- o problema não é duplicação de secret no verifier;
- existe drift entre a credencial administrativa atual do serviço e o registro administrativo persistido no banco R3;
- o bootstrap nativo criou a conta administrativa no primeiro boot;
- o pre-deploy atual sincroniza automaticamente apenas a conta QA sintética;
- nenhuma senha administrativa foi resetada durante o cutover.

Esse gate deve permanecer fail-closed até ressincronização explicitamente autorizada.

## 6. Rollback v3.1.1 preservado

Serviço preservado:

- `central-juridica-v3-1-1-cutover`
- service id: `56aa4fa8-07be-41ab-9a27-79bb27c3ea40`
- domínio: `central-juridica-v3-1-1-cutover-production.up.railway.app`
- source branch: `smoke/central-juridica-v3.1.1`

Último deployment `SUCCESS` identificado:

- deployment: `280944c9-84c8-4c96-b499-8167ccb8656b`
- snapshot: `95b07b9f-adae-4c69-80ac-bea296b045bc`
- source commit: `c2873d550991af51a596538fdf0166ba920f8935`
- status: `SUCCESS`
- `canRollback = true`

Deploys posteriores da v3.1.1 falharam; o serviço e o baseline aprovado foram deliberadamente preservados e não foram excluídos nem alterados neste cutover.

## 7. Métricas v3.2 na janela final

Última hora:

- CPU atual: `0.0000020333`
- CPU média: `0.0001774653`
- CPU máxima: `0.0040997`
- memória atual: `0.028991488 GB`
- memória média: `0.1217069325 GB`
- memória máxima: `0.165965824 GB`

Sem evidência de pressão de recurso no core.

## 8. Estado final

- canonical URL v3.2: **PASS**
- deploy v3.2: **PASS**
- readiness: **PASS**
- PostgreSQL R3: **PASS**
- DR separado: **PASS**
- least privilege: **PASS**
- backup/restore: **PASS**
- intake: **PASS**
- idempotência: **PASS**
- verifier operacional: **PASS**
- v3.1.1 preservada: **PASS**
- rollback baseline identificado: **PASS**
- admin credential current login: **FAIL / 401**
- MFA humano: **PENDING**
- reset administrativo automático: **NÃO EXECUTADO**

## 9. Próximo gate

A única ação sensível restante é ressincronizar de forma controlada a credencial administrativa no R3, preservando a exigência de MFA e invalidando sessões administrativas anteriores.

Essa ação altera credencial humana e deve receber autorização explícita separada.

Até lá:

- o core v3.2 permanece canônico e operacional;
- intake/QA técnico permanecem aprovados;
- recursos administrativos protegidos permanecem fail-closed;
- v3.1.1 permanece preservada como rollback.
