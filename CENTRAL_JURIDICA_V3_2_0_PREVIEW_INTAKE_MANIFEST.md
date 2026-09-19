# Central Jurídica v3.2.0-preview — Leads / Intake

Data: 2026-09-19

## Base certificada

- Runtime base: Central Jurídica v3.1.1
- Commit certificado: `c2873d550991af51a596538fdf0166ba920f8935`
- Produção v3.1.1: NÃO ALTERADA

## Candidata local selada

- Artefato: `central-juridica-app-v3.2.0-preview.zip`
- SHA-256: `70f5e0139b065cfdac574c3026f75432942219014b5bf96a6b7991f792e0e029`
- unzip integrity: PASS
- Baseline v3.1.1: 184/184 PASS
- Candidata v3.2.0-preview: 200/200 PASS
- Static check: PASS

## Escopo do delta

Novo domínio separado de Leads/Intake, sem reutilizar `clients` como prospects:

- `central_juridica_leads`
- endpoint externo create-only `POST /api/intake/leads`
- token de serviço dedicado `CJ_INTAKE_TOKEN`
- idempotência HMAC
- rate limit compartilhado
- auditoria append-only
- RBAC interno:
  - `leads:read`
  - `leads:write`
  - `leads:convert`
- conversão humana lead → client
- status `Convertido em cliente` bloqueado no PATCH comum; somente `/convert` pode produzi-lo.

## Bugs encontrados e corrigidos durante a auditoria

1. Bundle de transporte ficou inicialmente em v3.1.1 enquanto o core já estava v3.2.0-preview.
   - Corrigido regenerando bundle determinístico.

2. Auditoria do ator de serviço de intake gerava cadeia HMAC inválida ao persistir campo `username: undefined`.
   - Corrigido preservando somente campos definidos.

3. PATCH de lead permitia marcar `Convertido em cliente` sem criar cliente correspondente.
   - Corrigido: conversão somente pelo endpoint transacional dedicado.

## Neon — sandbox isolado

Projeto já existente e vazio reutilizado:
- Project: `central-juridica-production-app-v3-2`
- Project ID: `floral-violet-59866829`
- Branch: `main`
- Branch ID: `br-dark-flower-b5iy6irj`

Nenhum banco de produção v3.1.1 foi alterado.

Gate PostgreSQL real:
- tabela `central_juridica_leads`: PASS
- índices: PASS
- constraints de status/source/payload: PASS
- insert sintético: PASS
- update sintético: PASS
- status inválido rejeitado pelo PostgreSQL: PASS
- source inválido rejeitado pelo PostgreSQL: PASS

Existe um único registro sintético de gate no sandbox:
`lead_gate_20260919_v320`

Não contém dados reais de cliente.

## Site

O repositório `dkaminag/britopeovezan-site`, branch `audit/geo-crm-2026-09-19`, recebeu um adapter Cloudflare Pages Function:

`POST /api/intake`

O adapter é fail-closed e permanece inativo sem:
- `CJ_INTAKE_BASE_URL`
- `CJ_INTAKE_TOKEN`
- `TURNSTILE_SECRET_KEY`

Nenhum formulário público foi ativado.

## Estado dos gates

- CANDIDATE_SOURCE_TESTS = PASS
- STATIC_CHECK = PASS
- NEON_SANDBOX_SCHEMA = PASS
- PRODUCTION_V3_1_1_MUTATED = FALSE
- SITE_ADAPTER_CODED = TRUE
- SITE_ADAPTER_ACTIVE = FALSE
- CENTRAL_HTTPS_PREVIEW = PENDING
- SITE_TO_CENTRAL_E2E = PENDING
- PRODUCTION_READY = FALSE

## Regra

Esta branch NÃO é uma release de produção e não deve substituir `smoke/central-juridica-v3.1.1`.

Antes de qualquer promoção:
1. materializar a candidata em um preview HTTPS isolado;
2. executar smoke de `/api/health`, `/api/ready` e intake;
3. testar idempotência, rate limit e autenticação de serviço;
4. testar integração Pages Function → Central preview;
5. repetir regressão/secret scan;
6. realizar cutover controlado somente após evidência.
