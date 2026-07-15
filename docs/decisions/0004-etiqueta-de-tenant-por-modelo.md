# 0004 — Etiqueta de tenant por modelo (override sobre o tenant da integração)

- **Status:** Aceito
- **Data:** 2026-07
- **Contexto Plane:** WABA Collos (issue WABA-16 "Modelos: etiqueta de tenant por template")

## Contexto

A ADR 0001 escopa por `client_id` em `contacts`, `lists` e `integrations`, e
deriva o tenant das entidades filhas do pai (campanhas herdam o `clientId` da
integração). Modelos seguiam a mesma regra por construção: o tenant de um
template era o tenant da sua integração.

Isso não cobre o caso real: **uma mesma conta WABA serve vários tenants**. A
integração "Uniodontos WABA" está no pool compartilhado (`client_id` nulo) e
atende Campinas e outras Uniodontos. Como todo template dessa conta herdava o
tenant da integração, não havia como organizar modelos por tenant — ou todos
apareciam para todos, ou nada aparecia.

Esta é a **primeira entidade cujo tenant diverge do pai**.

## Decisão

1. **Override de tenant por template**: coluna `templates.client_id` (nullable).
   - Tenant **efetivo** = `template.client_id ?? integration.client_id`.
   - Scoping em `library.service.ts#templates()` via `isWithinScope(scope, efetivo)`.
   - Etiqueta nula/vazia = herda o tenant da integração (comportamento anterior).
   - Migração idempotente e não-destrutiva (`ADD COLUMN IF NOT EXISTS` + índice
     `idx_templates_client`) em `database.service.ts#migrateTenantSchema`, após o
     DDL de bootstrap.

2. **A semântica é MOVER, não compartilhar.** O `??` é override, não união:
   etiquetar o template T (da integração de A) para B faz **A perder** a
   visibilidade de T. Não existe "T visível para A e B". Ler isso como
   compartilhamento é a origem do próximo bug.

3. **Preservação no re-sync**: `replaceTemplatesInDatabase` faz DELETE+INSERT por
   `integration_id` e o `id` local é regerado a cada sync. Os overrides são lidos
   **antes** do DELETE, chaveados por `meta_template_id` (chave estável), e
   reaplicados no INSERT. Sem isso, todo sync de modelos zeraria as etiquetas.

4. **Invariante que sustenta o modelo**: `campaigns.service.ts#create()` amarra
   template e flow à **integração da campanha** — o template só resolve se
   `template.integrationId === integration.id`, e flows são buscados apenas entre
   os da integração. **A integração da campanha define o que pode ser usado
   nela.** Esta invariante foi o fix de um bloqueador: sem ela, a etiqueta tornava
   alcançável um vazamento do `FlowCacheRecord` (incl. `endpointUri`) do dono
   original via `inferredFlow`.

5. Etiquetagem é operação de admin Collos (`admin-tenants`), auditada com o valor
   **anterior** de cada etiqueta (`admin.tenant.templates_tagged`), para que uma
   etiquetagem errada seja reversível.

## Consequências

- A herança de tenant **deixou de ser universal**. Ao ler o tenant de um
  template, use sempre o efetivo (`template.clientId ?? integration.clientId`),
  nunca o da integração direto.
- `templates.client_id` não é gravado por `writeClientId` (ADR 0001): não é o
  tenant de criação, é um override administrativo posterior.
- Etiquetar um template **remove** a visibilidade do tenant anterior. Em conta
  compartilhada (`client_id` nulo), etiquetar tira o modelo do pool.
- **Dívida conhecida — flows não têm override.** `library.service.ts#flows()`
  ainda filtra pelo `clientId` da integração. Consequências, ambas falhas
  fechadas:
  - um template etiquetado que tenha botão de flow **não é utilizável em campanha
    por outro tenant** (a invariante 4 barra: 404);
  - o tenant etiquetado **não consegue ressincronizar** o modelo — `syncTemplates`
    checa o escopo da **integração**, não o do template.
  Ou seja: a etiqueta serve para organizar e visualizar modelos, não para
  habilitar o uso cross-integração. Remover esta limitação exige decidir o tenant
  efetivo de flows e o escopo do sync — nova ADR.
