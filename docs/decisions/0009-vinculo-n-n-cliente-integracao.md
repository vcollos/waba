# 0009 — Vínculo N:N cliente ↔ integração WABA (uma conta WhatsApp serve vários tenants)

- **Status:** Aceito
- **Data:** 2026-08
- **Contexto Plane:** WABA Collos (issue WABA-30)
- **Gate:** verificado contra cópia dos dados de produção (banco de rascunho)

## Contexto

De tempos em tempos, e **sem aviso**, um tenant perdia o acesso à conta
WhatsApp: uma campanha ou um disparo simplesmente não saía, e ao abrir a tela de
Clientes a integração aparecia desmarcada. Rebindar resolvia — até a próxima vez.

A causa não era perda de dado em restart nem em deploy. Era o **modelo**:
`integrations.client_id` guardava **um único** tenant, mas na prática **três
tenants dividem a mesma conta WABA** (`Uniodontos WABA`, phone
`382699438268621`):

| tenant | campanhas nessa integração |
|---|---|
| Uniodonto Campinas | 17 |
| Uniodonto do Brasil | 1 |
| Operação compartilhada | 5 |

Como o campo era exclusivo, marcar a integração no modal de um cliente a
**roubava** do outro. O `audit_log` registra o pingue-pongue por meses:

```
2026-07-21 → Brasil     2026-08-18 → Campinas
2026-07-24 → Campinas   2026-08-21 → Brasil
2026-07-27 → Brasil     2026-08-28 → Campinas
```

Pior, a tela de Clientes reconciliava **todas** as integrações a cada save
(`PATCH /integrations/:id/client` em laço), de modo que salvar o cliente A
podia desvincular o cliente B mesmo sem ninguém mexer na caixa dele.

## Decisão

### 1. O vínculo passa a ser N:N, numa tabela dedicada

Nova tabela `integration_clients (client_id, integration_id, created_at,
created_by)`, PK composta. É a **fonte de verdade** de quem pode usar cada conta
WABA. Um vínculo só desaparece por **ação explícita de um admin Collos** —
nenhum boot, deploy, sync de templates/flows ou edição de outro cliente o
remove.

> O nome não é `client_integrations` de propósito: já existe em produção uma
> tabela com esse nome, schema morto de uma tentativa relacional anterior (FK
> para uma tabela `clients` que o código não usa mais — os tenants vivem no blob
> `app_state`). Nada no código a lê ou escreve; ela ficou de fora desta mudança
> para não exigir migração destrutiva.

### 2. `integrations.client_id` vira campo **derivado**, não autoridade

Continua existindo, mas apenas como "tenant principal": é sempre o vínculo mais
antigo da integração, ou `NULL` quando não sobra nenhum
(`syncIntegrationPrimaryClients`). Serve para compatibilidade e como default do
tenant de uma campanha criada pela Collos sem seletor. **Nenhuma autorização o
consulta** — `list`, guards de sync, biblioteca, dashboard e disparo
transacional passaram a usar a tabela de vínculos.

Manter os dois em sincronia é o que impede o backfill de boot de ressuscitar um
vínculo recém-removido: desvinculou tudo, `client_id` zera junto.

### 3. Cada lado edita só os próprios vínculos

- `PUT /clients/:id/integrations` — conjunto final **deste cliente**;
- `PUT /integrations/:id/clients` — conjunto final **desta integração**.

O antigo `PATCH /integrations/:id/client` foi **removido**, não mantido por
compatibilidade: era ele que a tela de Clientes chamava em laço. Uma aba com o
bundle antigo carregado voltaria a rodar esse laço depois do deploy e apagaria
vínculos de novo — com o endpoint fora, ela recebe 404 e mostra erro, em vez de
perder dado em silêncio.

Salvar um cliente é **uma** chamada, e ela não toca nos vínculos de ninguém
mais. `POST /integrations` sem `clientIds` **não mexe** nos vínculos, e o campo
legado `clientId` num update é **aditivo** — editar uma integração nunca
desvincula por omissão.

Ambos gravam auditoria com `before`/`after`.

### 4. Backfill: recupera o que o modelo exclusivo tinha apagado

Duas fontes, com garantias distintas:

1. **`integrations.client_id`** — só para integração **sem nenhum vínculo**
   (linha legada). Roda em todo boot e é inócua depois da primeira vez: quem já
   tem vínculo não é tocado.
2. **Histórico de campanhas** — os pares `(clientId, integrationId)` das
   campanhas já criadas devolvem o acesso aos tenants que o perderam no
   pingue-pongue. Roda **uma única vez**, marcada em `schema_backfills`; sem
   essa trava, todo restart traria de volta vínculos que o admin acabou de
   remover.

Resultado verificado contra cópia dos dados de produção: `Collos Ltda → Collos`
e `Uniodontos WABA → Campinas + Brasil + Operação compartilhada`.

## Consequências

- **Templates de conta compartilhada ficam visíveis a todos os tenants
  vinculados.** É o comportamento coerente com dividir o mesmo número. A
  etiqueta de tenant por modelo (ADR 0004) continua sendo o jeito de restringir
  um template a um só tenant — quando `template.clientId` existe, ele vence.
- **A campanha precisa dizer de quem é.** Com a conta compartilhada,
  `campaign.clientId` não pode mais ser derivado da integração: passa a vir do
  escopo ativo (seletor da topbar / tenant do usuário), com fallback no tenant
  principal. Sem isso o custo de uma campanha do Brasil cairia em Campinas
  (ADR 0007).
- **Papel de cliente não vê com quem divide a conta**: `GET /integrations`
  devolve, para papéis de tenant, apenas o próprio `clientIds`. Quem administra
  vínculo é a Collos.
- A tela de Clientes deixou de mostrar "vinculada a outro cliente" (que sugeria
  exclusividade) e passou a mostrar "também em ⟨clientes⟩". A tela de
  Integrações troca o select "Cliente" por marcação múltipla "Clientes com
  acesso". No Organizador de tenants, a coluna "Tenant efetivo" virou "Quem
  enxerga" e lista todos os tenants que veem o modelo, já que um modelo sem
  etiqueta agora é visível a todos os vinculados à conta.
- Fica pendente a limpeza do schema morto (`client_integrations`, `clients`,
  FK de `users`), fora do escopo desta mudança.
