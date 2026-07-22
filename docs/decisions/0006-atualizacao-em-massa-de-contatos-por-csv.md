# 0006 — Atualização em massa de contatos por CSV (export filtrado + reimport por ID)

- **Status:** Aceito
- **Data:** 2026-07
- **Contexto Plane:** WABA Collos (a rastrear)
- **Gate:** Segurança APROVADO (`samuel`) + QA PASSOU (`debora`)

## Contexto

O import de CSV só sabia **criar** contatos (ADR 0002): casava por telefone e, na
prática, funcionava como um upsert de ingestão. Não havia caminho para **corrigir
em lote** o cadastro existente — trocar nome, e-mail, categoria e, o caso central,
**trocar o número de telefone** de um contato já cadastrado.

Casar por telefone é inviável para esse caso de uso: corrigir o telefone é
exatamente a operação que se quer permitir, e casar por telefone criaria um
**contato novo** em vez de atualizar o existente (o registro antigo ficaria órfão
com o número velho). Precisava-se de uma chave de casamento **estável** que não
seja o próprio dado sob edição.

Além disso, faltava a ponta de saída: para editar em massa o operador precisa
primeiro **extrair** o cadastro atual num CSV, mexer nele e reenviar.

## Decisão

### 1. Exportação em CSV do conjunto filtrado, via endpoint dedicado

A tela Contatos exporta o **conjunto atualmente filtrado** para CSV. A filtragem
e a paginação da tela são client-side sobre a página carregada, e o
`listContactsPage` **limita a página a 250** (`Math.min(250, ...)`) — então
exportar do estado da UI só enxergaria a página. Por isso a exportação usa um
**endpoint dedicado `GET /contacts/export`** que aplica os **mesmos filtros no
servidor (SQL), sem o cap**, calcula as badges de entrega e devolve todos os
contatos que batem; o CSV é montado no cliente a partir do retorno
(`apps/web/lib/csv.ts`). São **15 colunas**, com a **1ª sendo o `id`** (ID interno
do cadastro — a chave de reimportação), incluindo `external_ref` e as badges de
situação `situacao_falha`/`situacao_nao_lida`:

`id, external_ref, nome_completo, telefone, email, cliente_legado, categoria,
status, valido, opt_out, situacao_falha, situacao_nao_lida, listas, criado_em,
atualizado_em`.

`apps/web/lib/csv.ts` **espelha** a proteção anti-formula-injection de
`apps/api/src/common/csv.ts` (CWE-1236): células iniciadas por `= + - @`, tab ou
CR recebem apóstrofo antes, para o Excel/Sheets tratarem como texto (ex.: nome
`=HYPERLINK(...)`, telefone `+55...`). Prefixa BOM UTF-8 no download.

### 2. Modo atualização em massa acionado pela coluna `id`

O assistente de import (`CsvImportModal`, ADR 0002) entra em **modo atualização em
massa** quando o CSV tem a coluna `id` mapeada; sem `id`, segue o modo inserção
legado. No modo atualização, os contatos são casados pelo **ID interno do
cadastro** — chave estável — e **nunca por telefone**. Essa é a decisão central:
permite corrigir o telefone sem gerar duplicado.

### 3. Dry-run e job compartilham a mesma passada de classificação

`POST /contacts/imports/csv/plan` faz o **dry-run**: projeta
`updated / created / unchanged / conflicts / invalid` sem escrever nada. O wizard
pergunta **"Deseja atualizar XXX contatos alterados?"** e só grava no **"Sim"**.

Dry-run (`planCsvImport`) e job real (`processCsvUpdateJob`) chamam a **mesma**
`classifyCsvUpdate` — passada única, read-only, que decide linha a linha entre
atualizar / criar / manter / pular. Logo **a projeção sempre bate com o
resultado** (inclui a dedup de ID repetido dentro do arquivo e a previsão de
conflito de telefone via set de `phone_hash` reservados).

### 4. Semântica de atualização

- **Atualiza só campos preenchidos**: célula vazia **preserva** o valor atual (não
  apaga).
- **Linha órfã** (`id` em branco ou inexistente no tenant) vira **contato novo**
  com `newId()` — **nunca reusa o `id` do CSV**, para não vazar/colidir IDs entre
  tenants (isolamento multi-tenant, ADR 0001).
- **Não cria lista**: por isso o modo atualização **não grava em `imports`**, cuja
  `list_id` é `NOT NULL`. Sincronizar membership de lista não é objetivo deste
  fluxo.
- **Conflito de telefone** (UNIQUE composto `(COALESCE(client_id,''), phone_hash)`,
  ADR 0003) é **pulado e contado** em `conflicts`, **sem abortar o lote** — inclui
  a guarda para linhas sem telefone, que compartilham `hash('')`.

### 5. Colunas derivadas do export são ignoradas na reimportação

As colunas puramente informativas do export
(`valido, opt_out, situacao_falha, situacao_nao_lida, listas, criado_em,
atualizado_em`) estão em `RESERVED_EXPORT_HEADERS` e são **ignoradas** ao
reimportar, para não poluir `attributes_json`. Sem isso, um round-trip
export→import marcaria todo contato como "alterado". O set fica em sincronia com
`EXPORT_HEADERS` do frontend.

## Alternativas consideradas

- **Casar por telefone (reusar o upsert de ingestão)**: rejeitado — o caso de uso
  é justamente corrigir o telefone; casar por telefone criaria um contato novo e
  deixaria o registro antigo órfão. A chave de casamento não pode ser o dado sob
  edição.
- **Reusar a tabela `imports` também no modo atualização**: rejeitado —
  `imports.list_id` é `NOT NULL` e a atualização em massa não cria lista;
  forçá-la exigiria uma lista-fantasma sem valor.
- **Reaproveitar o `id` do CSV para a linha órfã**: rejeitado — IDs são internos
  por tenant; reusar um id vindo do arquivo quebraria o isolamento e poderia
  colidir. Órfã sempre recebe `newId()`.
- **Dry-run com contagem aproximada (heurística separada do job)**: rejeitado — a
  projeção divergiria do resultado. Uma única passada compartilhada garante que o
  "XXX a atualizar" é exato.

## Consequências

- **Novo eixo de escrita de contato**: além de criar (ADR 0002), o CSV agora
  **atualiza** cadastro existente. Quem raciocinar sobre "de onde vêm mudanças de
  contato" precisa considerar este modo, disparado pela presença da coluna `id`.
- A exportação aplica os filtros no **servidor** (`GET /contacts/export`), sem o
  cap de 250 de `listContactsPage`, e cobre o conjunto filtrado inteiro (teto de
  segurança 200k linhas). Corrige o bug da 1ª versão, que filtrava no cliente
  sobre uma página limitada a 250 e exportava um subconjunto (ex.: 19 de 1494).
- **Fora de escopo:** sincronização de membership de listas via CSV — a coluna
  `listas` é **informativa** no export e ignorada na reimportação.
- **Segurança/QA:** isolamento por tenant garantido via `writeClientId` +
  `COALESCE(client_id,'')` em todos os lookups (`loadContactsById`,
  `phoneHashTaken`); AuthZ por `CONTACTS_WRITE_ROLES` nas rotas
  `/contacts/imports/csv/plan` e `/contacts/imports/csv`. Anti-formula-injection
  no export espelhando `apps/api/src/common/csv.ts`.
