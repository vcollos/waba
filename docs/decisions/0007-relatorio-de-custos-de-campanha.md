# 0007 — Relatório de custos de campanha (pricing da Meta como classificação + tarifa BRL da Collos)

- **Status:** Aceito
- **Data:** 2026-08
- **Contexto Plane:** WABA Collos (issue WABA-23)
- **Gate:** Segurança APROVADO (`samuel`/`téo`) + QA PASSOU (`debora`)

## Contexto

O painel media entrega (funil `accepted/sent/delivered/read/failed`) mas **não
tinha nenhuma noção de custo**. Não havia como responder "quanto custou esta
campanha" nem gerar um relatório financeiro por período/tenant.

A Meta **já envia**, em cada status de mensagem no webhook, um objeto `pricing`
(`payload...statuses[].pricing`: `{type, billable, category:
utility|marketing|authentication, pricing_model: PMP}`) — até então **descartado**
no `handleStatus`. Dois fatos importam:

- a Meta manda a **classificação de cobrança** (categoria, se é billable, o
  modelo de preço), mas **não manda valor monetário**;
- o valor em BRL é uma **decisão comercial da Collos** — a tarifa que a Collos
  cobra do tenant por categoria, que não é o mesmo que a Meta cobra da Collos e
  ainda leva impostos/nota fiscal por cima.

Ou seja: a fonte da *classificação* é a Meta; a fonte do *preço* tem de ser uma
tabela mantida pela Collos.

## Decisão

### 1. Extrair o `pricing` do webhook como fonte da classificação de cobrança

`webhooks.service.ts#handleStatus` passa a ler `statuses[].pricing` e persistir
`pricing_category` / `pricing_billable` / `pricing_model` em `campaign_messages`.
A extração é **try/catch e não bloqueia** o fluxo de status — se o pricing vier
ausente ou malformado, o status continua sendo aplicado normalmente.

### 2. Preço em BRL vem de uma tabela de tarifas da Collos, não da Meta

Nova tabela `pricing_rates` (categoria → preço BRL), com **UNIQUE `(client_id,
category)`**. É **um valor atual por categoria**, sem vigência por data: o upsert
por `(client_id, category)` **sobrescreve** `unit_price_brl`. `client_id`
**null = tarifa global** que vale para **todos os clientes**. `resolvePricingRate
(clientId, category)` resolve sem data — usa a linha do tenant se existir, senão
a global. O custo de uma mensagem = tarifa atual da sua `pricing_category`.

**Não há histórico por data:** ao alterar uma tarifa, o novo valor passa a valer
para **todos os relatórios, passados e futuros** — um relatório de um período
antigo é recalculado com o preço vigente hoje.

Só a Collos edita tarifa: **preço é decisão comercial** — o tenant não edita a
própria fatura (ver item 5).

### 3. Imposto de nota fiscal é aditivo (gross-up)

Nova tabela `report_settings` com `nota_fiscal_pct` (default **10.98**),
escopável por tenant. O relatório calcula:

```
total = subtotal + subtotal * nota_fiscal_pct / 100
```

O imposto é **somado** ao subtotal (gross-up), não embutido. Deixa explícito no
relatório quanto é serviço e quanto é imposto.

### 4. PDF é HTML print-ready, não binário

`GET /reports/campaigns/export.pdf` devolve **HTML pronto para impressão**
(Ctrl+P → salvar como PDF no navegador), **não** um binário gerado no servidor.
Decisão deliberada de infraestrutura: **não subir Chromium/puppeteer na VPS**,
que está com disco em **86%**. O CSV (`export.csv`) cobre o consumo por planilha.

### 5. Modelo de papéis financeiro (dois níveis)

- **VER** o relatório de custos: `super_admin` / `admin` / `client_admin`
  (o `client_admin` vê a fatura do próprio tenant). `viewer`/`operator` → **403**.
- **EDITAR** tarifas e `nota_fiscal_pct`: `super_admin` / `admin` **apenas**
  (Collos-only) — o tenant não altera o preço que lhe é cobrado.

Isolamento por tenant no backend via `scope.ts`
(`resolveClientScope`/`writeClientId`), com **defesa em profundidade** contra
reatribuição de tarifa por `id` entre tenants.

### 6. Módulo `reports` reaproveita o funil existente

Novo módulo `apps/api/src/reports/`:
`GET /reports/campaigns?from&to&clientId`, `GET /reports/campaigns/export.csv`,
`GET /reports/campaigns/export.pdf`, `GET/POST /reports/rates`,
`GET/PUT /reports/settings`. Reusa `results.service.ts` / `campaign-metrics.ts`
para funil e contagens — não reimplementa agregação.

### 7. Dados: migração incremental + backfill idempotente

- Colunas novas em `campaign_messages` via `migrateTenantSchema()` (ALTER
  idempotente, aditivo). O **SQLite legado não tem tabela relacional de
  `campaign_messages`** (guarda em `app_state`), então essa camada é Postgres.
- `scripts/backfill-pricing.mjs` popula o histórico já recebido: casa
  `message_events` → `campaign_messages` por `provider_message_id`, dedup por
  wamid preferindo `billable=true` / evento mais recente, e **só preenche linhas
  com `pricing_category IS NULL`**. Dry-run por padrão; `--execute` aplica.

## Alternativas consideradas

- **Tarifa 100% manual, ignorando o `pricing` da Meta**: rejeitada — o operador
  teria de classificar cada mensagem como utility/marketing/auth na mão. A Meta
  já entrega essa classificação de graça no webhook; descartá-la seria trabalho
  manual e fonte de erro. Usamos a Meta para *classificar* e a tabela só para
  *precificar*.
- **Extrair o valor monetário da fatura real da Meta**: rejeitada — a Meta não
  manda valor no webhook, e o preço relevante para o relatório é o que a **Collos
  cobra do tenant** (com margem/impostos), não o que a Meta cobra da Collos.
  Reconciliação com a fatura real fica fora de escopo (ver consequências).
- **Câmbio USD→BRL + IOF automáticos**: rejeitada — o custo já entra direto em
  **BRL** pela tabela da Collos; não há conversão de moeda no fluxo. Trazer
  câmbio/IOF adicionaria dependência de cotação sem necessidade.
- **PDF binário via Chromium/puppeteer no servidor**: rejeitada — VPS com disco
  em 86%; subir headless browser é peso desproporcional. HTML print-ready entrega
  o mesmo resultado sem inflar a imagem/instância.
- **Tenant edita a própria tarifa**: rejeitada — preço é decisão comercial da
  Collos; tenant editar a própria fatura é conflito de interesse. Edição é
  Collos-only.
- **Vigência histórica de tarifa por data (`effective_from`)**: considerada e
  **descartada a pedido do usuário**. Manter preço por período permitiria
  recompor a fatura de um mês com a tarifa daquela época, mas o usuário preferiu
  **simplicidade**: um único valor atual por categoria, global, que vale para
  todos os relatórios (passados e futuros). Consequência aceita: alterar a tarifa
  recalcula relatórios antigos; não há reconstrução histórica de preço.

## Consequências

- **Nova camada de custo, inédita no projeto.** Quem raciocinar sobre
  `campaign_messages` agora tem três colunas de pricing; quem mexer no
  `handleStatus` precisa preservar a extração do `pricing`.
- **Pendência operacional obrigatória:** as colunas de pricing nascem na
  **migração de boot** do backend, então o backfill só pode rodar **após o
  deploy**. Rodar **uma vez** `node scripts/backfill-pricing.mjs --execute` na
  VPS para preencher o histórico anterior à mudança. Sem isso, campanhas antigas
  aparecem sem custo. O script é idempotente (só toca `pricing_category IS NULL`).
- **Fora de escopo (registrado):** conversão de moeda/câmbio/IOF de cartão;
  relatórios persistidos/agendados; reconciliação com a fatura real da Meta.
- **DoS conhecido (melhoria futura):** o relatório carrega mensagens em memória
  para agregar; em janelas muito largas × tenant grande isso pressiona a
  instância. Aceitável no volume atual; paginação/agregação em SQL é o follow-up.
- **Segurança/QA:** VER = `super_admin`/`admin`/`client_admin`;
  EDITAR = `super_admin`/`admin`. Isolamento por `scope.ts` com defesa em
  profundidade contra reatribuição de tarifa por `id`. Imposto aditivo
  (gross-up) auditável no relatório.
