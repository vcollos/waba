# 0002 — Inclusão de contatos em listas: Manual, CSV e API por token de tenant

- **Status:** Aceito
- **Data:** 2026-07
- **Contexto Plane:** WABA Collos (issues "Listas: ... botao Importar e template CSV",
  "Listas: inclusao Manual", "Listas: inclusao CSV", "Listas: inclusao via API")

## Contexto

A tela **Listas** expõe três origens (`source_type`): `manual`, `csv`, `api`.
Nenhuma estava operacional na UI. Um tenant só pode ver/alimentar as próprias
listas (ver [0001](0001-arquitetura-multitenant.md)).

## Decisão

Cada origem tem um caminho de inclusão explícito na tela Listas, em vez de um
único dropdown "Origem" sem ação:

1. **Manual** — botão "Nova lista" cria a lista (escopada ao tenant ativo); o
   drawer "Ver lista" tem um formulário "Adicionar contato" que faz
   `POST /contacts` com `listIds:[listId]` e `clientId` = tenant ativo. Reusa
   `ContactsService.createContact`.

2. **CSV** — botão "Importar CSV" abre o **assistente compartilhado**
   `components/csv-import-modal.tsx` (`CsvImportModal`), extraído do que existia
   duplicado em Contatos (agora ambas as telas usam o mesmo componente). Fluxo de
   3 passos: preview → mapeamento → import em job de segundo plano
   (`/contacts/imports/csv`). Botão "Baixar template CSV" gera o arquivo modelo no
   cliente (`downloadCsvTemplate`, colunas `nome_completo,telefone,email,categoria`).
   O import agora aceita `clientId`, para o admin Collos importar direto no tenant
   selecionado (antes caía no escopo compartilhado).

3. **API** — **token por tenant** + endpoints públicos de ingestão:
   - Tabela `api_tokens` (id, `client_id`, name, `token_prefix`, `token_hash`,
     `last_used_at`, `revoked_at`, ...). **Só o hash (sha256) é persistido**; o
     texto puro (`wba_<48 hex>`) é exibido **uma vez** na UI.
   - `ApiTokensService` (gerar/listar/revogar, escopado) + `ApiTokensController`
     (`/api-tokens`, JWT, papéis `super_admin`/`admin`/`client_admin`).
   - `ApiTokenGuard`: lê `Authorization: Bearer <token>`, resolve o `clientId` e
     injeta uma sessão sintética escopada em `request.user`, reusando a mesma
     lógica de escopo dos serviços.
   - `PublicApiController` (`@Public()` + `ApiTokenGuard`), rotas sob
     `/api/public/v1`:
     - `GET  /public/v1/lists` — listas do tenant do token.
     - `POST /public/v1/lists` — cria lista (origem `api`).
     - `POST /public/v1/lists/:id/contacts` — **upsert** de contatos por
       `phone_hash` + associação à lista (`ContactsService.apiIngestContacts`).
   - Ingestão isolada: a lista precisa pertencer ao tenant do token; contatos já
     vinculados a **outro** tenant são **pulados** (não vazam entre tenants).
     Limite de 5000 contatos por requisição.

## Alternativas consideradas

- **Dropdown único de origem no "Nova lista"**: rejeitado — pontos de entrada
  distintos (Nova lista / Importar CSV / Tokens de API) deixam cada fluxo óbvio.
- **Token global (não por tenant)**: rejeitado — quebraria o isolamento; o token
  carrega o `clientId` e define o escopo da ingestão.
- **Guardar o token em claro**: rejeitado — só hash; exibição única.

## Consequências

- Nova superfície pública autenticada por token: qualquer rota futura sob
  `/public/v1` deve passar pelo `ApiTokenGuard` e nunca confiar em `clientId` do
  corpo — o tenant vem sempre do token.
- Revogação é imediata (o `resolveClientId` ignora tokens com `revoked_at`).
- `CsvImportModal` é a fonte única do assistente CSV; alterações no fluxo de
  importação devem ser feitas nele (não duplicar por tela).
