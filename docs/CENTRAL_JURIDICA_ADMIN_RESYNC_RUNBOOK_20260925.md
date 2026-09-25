# Central Jurídica v3.2 — Runbook de ressincronização administrativa

**Data:** 25/09/2026  
**Estado:** `PREPARED / NOT AUTHORIZED FOR EXECUTION`  
**Escopo:** preparar uma única operação controlada para eliminar o drift entre `CJ_ADMIN_PASSWORD` e a conta administrativa persistida no PostgreSQL R3, sem reduzir a política de MFA.

## 1. Estado de partida

- runtime canônico: `central-juridica-v3-2-prod`;
- Source of Truth de aplicação: `dashboard-app@d76a2dbf257853d495c177f7930c20c5ce5278bc`;
- runtime jurídico pinado: `d507a9955be07ef710d410b5263686ac75caeeff`;
- banco primário: `central_juridica_v32_prod_r3`;
- último full smoke conhecido: `ADMIN_LOGIN_FAILED_401`;
- verifier usa `CJ_ADMIN_USER` e `CJ_ADMIN_PASSWORD` por Railway reference variables;
- repetir o full smoke com as referências canônicas continuou retornando 401;
- portanto o blocker é drift entre a credencial desejada pelo serviço e o hash administrativo persistido no R3;
- o bootstrap original criou a conta administrativa apenas no primeiro boot;
- o pre-deploy atual sincroniza automaticamente somente a conta QA sintética por `sync-qa-user.mjs`.

A presença das seguintes variáveis no serviço canônico foi revalidada por nome em 25/09/2026, sem leitura de valores:

- `CJ_ADMIN_USER`;
- `CJ_ADMIN_PASSWORD`;
- `CJ_MFA_REQUIRED_ROLES`;
- `CJ_DATABASE_URL`;
- `CJ_PG_SSL`;
- `CJ_AUDIT_KEYRING`.

## 2. Gate de autorização

Nenhuma etapa de mutação abaixo deve ser executada sem autorização humana explícita e separada para:

1. ressincronizar a senha administrativa persistida com a credencial canônica já configurada no serviço;
2. revogar todas as sessões administrativas anteriores;
3. preservar a configuração/segredo de MFA existente sem zerá-la ou contorná-la.

A autorização deve ser específica para esta operação. Não interpretar `continue`, `prossiga` ou outra autorização genérica como autorização de credencial/MFA.

## 3. Invariantes da operação

A implementação autorizada deve:

- usar o mesmo `hashPassword` do runtime v3.2; não criar um algoritmo paralelo;
- localizar a conta exclusivamente por `CJ_ADMIN_USER` normalizado;
- executar `SELECT ... FOR UPDATE` dentro de uma transação;
- falhar se a conta não existir;
- falhar se `role !== "admin"` ou `active !== true`;
- nunca registrar a senha, o hash ou material MFA;
- alterar somente os campos necessários ao hash/sinalização de troca de senha e timestamps;
- preservar todos os campos MFA existentes byte-semanticamente, salvo uma futura operação humana de enrollment explicitamente separada;
- remover as linhas de `central_juridica_sessions` pertencentes ao admin;
- registrar evento de auditoria sem segredo, usando a cadeia/keyring canônica;
- realizar `COMMIT` somente após todos os invariantes locais passarem;
- executar `ROLLBACK` em qualquer erro anterior ao commit.

A referência de comportamento para hashing, transação, sessão e audit trail é o já aprovado `central-juridica-railway-v3.2.0/sync-qa-user.mjs` do pin `d507a9955be07ef710d410b5263686ac75caeeff`. A futura rotina administrativa deve reutilizar esses componentes, mas **não** relaxar a restrição sintética existente do sync QA.

## 4. Pré-check obrigatório

Antes da mutação:

1. confirmar `/api/health = 200` e `/api/ready = 200`;
2. confirmar o deployment canônico v3.2 em estado saudável;
3. confirmar que o verifier está no modo operacional normal, não em uma variante de diagnóstico persistente;
4. confirmar por nomes/refs que `CJ_ADMIN_USER`, `CJ_ADMIN_PASSWORD`, `CJ_MFA_REQUIRED_ROLES`, `CJ_DATABASE_URL` e audit keyring estão presentes;
5. confirmar que o R3 alvo é `central_juridica_v32_prod_r3`, nunca DR;
6. confirmar que o usuário encontrado tem exatamente uma identidade administrativa ativa;
7. capturar apenas evidência não secreta: user id, username normalizado, role, active, presença/estado de MFA permitido pelo schema e contagem de sessões;
8. não copiar senha/hash/MFA secret para logs, artefatos, issue, PR ou chat.

Se qualquer identidade/alvo for ambíguo: `BLOCKED`.

## 5. Mutação autorizada — sequência atômica

Dentro de uma única transação:

1. bloquear a linha administrativa com `FOR UPDATE`;
2. derivar o novo `passwordHash` a partir de `CJ_ADMIN_PASSWORD` usando o helper do runtime;
3. manter intactos campos MFA e demais atributos administrativos não relacionados;
4. atualizar `passwordHash`, `passwordChangedAt` e `updatedAt`;
5. revogar todas as sessões do mesmo `user_id`;
6. acrescentar audit entry `ADMIN_CREDENTIAL_RESYNCED`, contendo somente metadados não secretos, inclusive `sessionsRevoked=true`;
7. persistir a cadeia de auditoria;
8. commit.

Não criar segunda conta admin. Não alterar `CJ_ADMIN_USER`. Não desativar MFA. Não transformar o fluxo em bootstrap.

## 6. Verificação pós-commit

Imediatamente após o commit:

1. executar o full smoke usando as reference variables do serviço canônico;
2. exigir que o login deixe de falhar em 401 por senha;
3. exigir que recursos protegidos continuem fail-closed sem sessão válida;
4. verificar que sessão anterior ao resync não é aceita;
5. se a conta já tiver MFA configurado, exigir que o fluxo continue exigindo o segundo fator conforme a política;
6. se MFA estiver pendente para o humano, classificar `PASSWORD_RESYNC = PASS` e `MFA_ENROLLMENT = PENDING HUMAN`; não contornar o segundo fator;
7. reexecutar o verifier operacional normal e confirmar que intake/QA/core não sofreram regressão;
8. registrar deployment/smoke ids no Source of Truth.

## 7. Critérios de aceite

Somente marcar o gate administrativo PASS quando houver evidência de:

- credencial administrativa ressincronizada;
- login administrativo deixa de falhar por drift;
- sessões antigas revogadas;
- política de MFA preservada;
- MFA humano concluído, quando exigido;
- audit trail válido;
- core/readiness/intake/QA sem regressão.

Estados intermediários permitidos:

- `ADMIN_PASSWORD_RESYNC = PASS / MFA = PENDING`;
- `ADMIN_PASSWORD_RESYNC = FAIL`;
- `ADMIN_GATE = BLOCKED`.

Nunca converter um desses estados em `ADMIN_PRODUCTION_READY = TRUE` sem completar os critérios acima.

## 8. Falha e recuperação

- antes do commit: `ROLLBACK` e nenhuma alteração persistida;
- após commit com login ainda inválido: manter fail-closed, não repetir resets automaticamente; auditar identidade/config/schema antes de nova mutação;
- não restaurar sessões revogadas;
- não utilizar o serviço v3.1.1 de rollback como atalho para o gate administrativo;
- rollback da aplicação só é considerado se houver regressão de runtime/core, não por mero drift de credencial.

## 9. Fora deste runbook

Não autorizado por este documento:

- enrollment/reset de MFA sem presença humana;
- desativar `CJ_MFA_REQUIRED_ROLES`;
- revelar ou exportar secret MFA;
- criar novo admin para contornar a conta persistida;
- alterar credenciais QA/intake;
- mexer em dados jurídicos/clientes;
- promover Legal Agent com matéria real;
- qualquer filing/protocolo ou PJe-Calc real.

## 10. Próxima ação humana mínima

Quando houver autorização explícita, a execução deve ser uma única janela controlada:

**preflight → transação de resync → revogação de sessões → audit entry → full smoke → MFA humano (se necessário) → revalidação final.**

Até essa autorização, este runbook encerra toda a preparação não destrutiva possível para o gate administrativo.
