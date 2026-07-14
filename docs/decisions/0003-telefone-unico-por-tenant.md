# 0003 — Unicidade de telefone por tenant (composite key)

- **Status:** Aceito
- **Data:** 2026-07
- **Contexto Plane:** WABA Collos (issue "Seguranca #2: oraculo de enumeracao cross-tenant")

## Contexto

`contacts.phone_hash` tinha um **UNIQUE global**. Consequências:
1. Impedia o mesmo número existir em dois tenants (Uniodontos diferentes) — quebra
   o multi-tenant de contatos.
2. Abria um **oráculo de enumeração cross-tenant** (achado de segurança #2): a
   ingestão via API (`apiIngestContacts`) pulava telefones de outro tenant e o
   contador `skipped` revelava, por resposta, se um número já era cliente de
   **outra** Uniodonto.

A base de produção estava **inteira sob um único tenant** (`default-shared-client`,
281k+ contatos, zero `client_id` nulo, zero colisão) — então a mudança pôde ser
feita **sem migração de dados destrutiva**.

## Decisão

Unicidade de telefone passa a ser **por tenant**: índice único composto
`(COALESCE(client_id, ''), phone_hash)` no lugar do `contacts_phone_hash_key`
global. `COALESCE` trata o pool compartilhado (`client_id` nulo) como um tenant
próprio, preservando unicidade lá também.

Migração idempotente e não-destrutiva em `migrateTenantSchema` (cria o índice
composto **antes** de dropar o global; a base atual já satisfaz a nova regra).

Deduplicação escopada por tenant em todos os caminhos de escrita:
- `ensurePhoneIsUniqueInDatabase(db, phoneHash, clientId, excludeId?)` — filtra por tenant;
- `createContact` / `updateContact` passam o `clientId` do contato;
- import CSV (`processCsvImportJob`) carrega `existingContacts` só do tenant do import;
- `apiIngestContacts` faz lookup por `(client_id, phone_hash)`.

## Consequências

- O mesmo número pode existir em tenants diferentes (entidades independentes).
- **Oráculo #2 fechado**: no `apiIngestContacts`, telefone de outro tenant é
  invisível → entra como novo contato deste tenant → resposta indistinguível de
  qualquer telefone novo; `skipped` não é mais incrementado por causa de tenant.
- O import CSV deixou de reaproveitar contatos de outro tenant (fecha a divergência
  de isolamento legada em `processCsvImportJob`).
- Qualquer novo caminho que insira contato **deve** escopar a unicidade por
  `client_id` (não voltar a assumir unicidade global de telefone).
