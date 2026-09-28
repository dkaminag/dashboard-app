# Central Jurídica → Legal Agent — pacote de revisão humana da fixture artificial desidentificada

**Data:** 2026-09-28  
**Escopo:** fixture artificial apenas  
**Real client source authorized:** FALSE  
**Real matter authority:** FALSE  
**Production authority:** FALSE

## Fixture a revisar

Digest SHA-256 da versão exata abaixo:

`sha256:9d55aff6e5a54d095da59f9f9b39d9a71e018c8dc46973322770331d377ebc29`

> FIXTURE ARTIFICIAL. [EMPRESA_A], identificada apenas como [PARTE_A], discute contrato com [PESSOA_A] no [PROCESSO_A]. Contato e endereço foram substituídos por [CONTATO_A] e [ENDERECO_A]. Nenhum dado corresponde a cliente real.

## Checklist obrigatório da revisão humana

O revisor `lawyer` deve confirmar, sobre **somente o texto acima**:

1. não há nome real, razão social real, CPF, CNPJ, número de processo, e-mail, telefone, CEP, endereço ou outro identificador estruturado;
2. não há combinação de fatos livres que permita reconhecer razoavelmente uma pessoa, empresa, processo ou cliente real;
3. os placeholders não carregam significado identificável além do papel genérico no texto;
4. não há estratégia jurídica, fato confidencial, valor, data, local, relação societária, evento raro ou outro detalhe contextual que permita reidentificação;
5. a conclusão da revisão se limita à fixture artificial e **não autoriza** uso de documento ou processo real.

## Atestado aceito pelo executor

Somente uma confirmação humana explícita autoriza o fechamento deste gate.

Valores exigidos pelo executor:

- `reviewed=true`
- `role=lawyer`
- `freeTextReviewed=true`
- `attestationKind=REAL_HUMAN_LAWYER_REVIEW`

A revisão humana **não** altera:

- `realSourceAuthorized=false`
- `realMatterAuthority=false`
- `productionAuthority=false`

## Frase de confirmação sugerida

`Revisão humana lawyer aprovada para a fixture artificial digest sha256:9d55aff6e5a54d095da59f9f9b39d9a71e018c8dc46973322770331d377ebc29. Confirmo que o texto não contém identificadores estruturados nem pistas livres razoáveis de reidentificação. Escopo exclusivamente artificial.`

Qualquer alteração no texto exige novo digest e nova revisão humana.
