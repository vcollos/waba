# 0001 — Arquitetura multi-tenant (isolamento por `clientId` + papéis)

- **Status:** Aceito
- **Data:** 2026-07
- **Contexto Plane:** WABA Collos (issues "Migracao multi-tenant..." e "Isolamento por tenant...")

## Contexto

A Collos opera o painel WABA em nome de múltiplas Uniodontos (tenants). Cada
cliente só pode ver os próprios dados (contatos, listas, integrações, campanhas,
modelos, resultados); apenas a Collos (administração da plataforma) vê tudo.

## Decisão

1. **Isolamento por `clientId`**, imposto no **backend** (nunca só na UI):
   - Coluna `client_id` (nullable) nas tabelas relacionais grandes: `contacts`,
     `lists`, `integrations`. Campanhas herdam o `clientId` da integração.
   - Migração idempotente e não-destrutiva (`ALTER TABLE ... ADD COLUMN IF NOT
     EXISTS`) em `database.service.ts#migrateTenantSchema`. Linhas legadas ficam
     com `client_id` nulo (escopo compartilhado) até serem atribuídas.

2. **Papéis** (`common/roles.ts`):
   - `super_admin` / `admin` → Collos, `clientIds: []` = vê todos os tenants.
   - `client_admin` / `operator` / `viewer` → escopados a `clientIds[]`.
     `viewer` = só leitura; `operator` = operacional (sincroniza modelos, cria
     campanhas); `client_admin` = admin do tenant (inclui gerir tokens de API).
   - Usuário tem 1+ tenants e opera **um por vez** (seletor na topbar → query
     `?clientId=`).

3. **Resolução de escopo centralizada** (`common/scope.ts`):
   - `resolveClientScope(session, requested)` → `null` (todos, só Collos) ou um
     `clientId` estrito. Fail-closed: cliente sem tenant recebe `'__none__'`.
   - `writeClientId(session, requested)` → `clientId` a gravar ao criar registros.
   - `isWithinScope(scope, recordClientId)` para checagens de leitura/ação.
   - `sessionClientIds(session)` tolera token legado (`clientId` único) para não
     zerar o escopo até o relogin.

## Consequências

- Não dá para burlar via `?clientId=`: um papel de cliente sempre cai no próprio
  conjunto. Acesso cruzado retorna 404.
- Toda nova entidade escopável **deve** gravar `client_id` via `writeClientId` e
  filtrar leituras via `resolveClientScope`/`isWithinScope`.
- Operações de escrita a partir de um admin Collos com tenant ativo no seletor
  devem propagar esse `clientId` (ex.: import CSV, criação de listas/contatos),
  senão caem no escopo compartilhado (nulo).
