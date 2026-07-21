# 0005 — Disparo transacional por API pública (envio síncrono fora do poller)

- **Status:** Aceito
- **Data:** 2026-07
- **Contexto Plane:** WABA Collos (issue "API: disparo transacional")
- **Gate:** Segurança APROVADO (`samuel`) + QA PASSOU (`debora`)

## Contexto

O painel só sabia enviar mensagens por **campanha em lote**: `DispatchService`
faz poll de `campaign_messages` em estado `queued`/`sending` e envia. Não havia
caminho para **disparo transacional** — o caso em que o cliente precisa mandar
uma mensagem única, na hora, disparada por um evento do próprio sistema dele
(OTP/token de autenticação, confirmação de assinatura de venda), operando em
**"modo serviço" via API, sem painel web**.

A superfície pública por token de tenant já existia para ingestão de contatos
(ADR 0002): `PublicApiController` + `ApiTokenGuard`, tenant sempre derivado do
token. Esta ADR estende essa superfície para envio de mensagens.

## Decisão

### 1. Endpoint público, tenant sempre do token

`POST /api/public/v1/messages` no `PublicApiController` (`@Public()` +
`ApiTokenGuard`). Reusa o mecanismo de token da ADR 0002 — **o tenant vem sempre
do token, nunca do corpo**. Não foi criado tipo novo de cliente: "modo serviço"
não é um flag de conta, é apenas um tenant que consome por token em vez de UI. O
isolamento é o mesmo de qualquer rota `/public/v1`.

- Headers: `Authorization: Bearer wba_...`, `Idempotency-Key` (opcional).
- Body: `{ to, template, language?, variables?, integrationId?, callbackUrl? }`.
- Resposta: `{ id, providerMessageId, status: 'accepted', to, callbackSecret? }`.

### 2. Envio síncrono, fora do poller

O disparo **não** entra no `DispatchService`. É resolvido na própria requisição:

1. Resolve a integração do tenant: **0 integrações → 400**; **>1 sem
   `integrationId` → 400** (ambíguo); com `integrationId`, valida pertencimento
   ao tenant.
2. Resolve o template **APROVADO** por nome (+ idioma), **restrito às categorias
   `UTILITY`/`AUTHENTICATION`** (transacional; marketing não passa por aqui).
3. Monta o payload a partir de `variables`: **NAMED** por `paramName`,
   **POSICIONAL** por índice. Para `AUTHENTICATION`, anexa o botão copy-code
   (`sub_type: 'url', index: '0'`) com o código.
4. Envia via `MetaGraphService`, persiste e retorna `providerMessageId`.

### 3. Rastreio reusa `campaign_messages` (campanha-canal singleton)

Em vez de uma tabela paralela de mensagens, cada envio transacional é uma
`campaign_messages` em estado `accepted`, pendurada numa **campanha singleton
por integração** de id `svc:<integrationId>`, criada com status `completed`.

- `completed` é **invisível ao poller** (que só pega `queued`/`sending`), então o
  disparo síncrono nunca colide com o lote.
- Como é `campaign_messages`, o envio **herda de graça** funil, atualização por
  webhook e cobrança — sem duplicar essa infraestrutura.

### 4. Tabela fina só para idempotência + callback

`transactional_dispatches` (`UNIQUE(client_id, idempotency_key)`, `callback_url`,
`callback_secret`) existe **só** para deduplicar por `Idempotency-Key` e guardar
o destino/segredo do callback. Não reimplementa estado de mensagem — isso vive em
`campaign_messages`. DDL **aditivo e idempotente** em
`database.service.ts#migrateTenantSchema` (SQLite + Postgres).

### 5. Callback de saída assinado

Ao receber o status da Meta no webhook, o sistema faz `POST` para `callback_url`
com `X-Waba-Signature: sha256=HMAC(corpo, callback_secret)`, **best-effort com
retries**. O `callback_secret` é retornado **uma única vez** na resposta do
disparo (mesma disciplina do token puro na ADR 0002).

### 6. Segurança endereçada no gate

- **SSRF no callback** fechado em `callback-url.ts`: classificação de IP **em
  bytes** (bloqueia loopback, RFC1918, link-local, ULA, multicast, NAT64,
  IPv4-mapeado — inclui a metadata da nuvem `169.254.169.254`). O IP validado é
  **fixado (pin) no connect**; https-only; sem seguir redirect; validado **na
  entrada e no envio**.
- **Código OTP redigido** (`***`) no payload persistido (`record_json` /
  `payloadHash`) — o código nunca fica em claro no banco.
- **Opt-out do tenant suprime o envio (409)**.
- **Rate-limit por token**: 10/s + 300/min (in-memory).

## Alternativas consideradas

- **Novo tipo de cliente "serviço"**: rejeitado — o token já carrega o tenant e o
  isolamento; um flag de conta seria redundante e criaria um segundo eixo de
  autorização.
- **Enfileirar o transacional no `DispatchService`**: rejeitado — latência de
  poll é inaceitável para OTP; o valor do transacional é a resposta síncrona com
  `providerMessageId`.
- **Tabela própria de mensagens transacionais**: rejeitado — duplicaria funil,
  webhook e cobrança. A campanha singleton `svc:<integrationId>` reaproveita tudo.
- **Callback sem pin de IP (só validar o hostname)**: rejeitado — vulnerável a
  DNS rebinding; validar na entrada e reresolver no connect deixaria brecha. O IP
  é fixado após a validação.

## Consequências

- **Primeiro caminho de escrita de mensagem que não passa pelo poller de
  dispatch.** É a exceção explícita às ADRs anteriores: quem raciocinar sobre "de
  onde saem mensagens" precisa considerar tanto `DispatchService` quanto este
  envio síncrono. A `campaign_messages` em `accepted` sob `svc:<integrationId>`
  não é criada por lote.
- Toda nova rota sob `/public/v1` continua obrigada ao `ApiTokenGuard` e a nunca
  confiar em `clientId` do corpo (ADR 0002).
- **Limitações conhecidas (follow-ups):**
  - o **opt-out atual bloqueia inclusive OTP/AUTHENTICATION** — mensagem de
    autenticação é frequentemente esperada mesmo após opt-out de marketing.
    Follow-up: opt-out **por categoria**.
  - **rate-limit é por instância** (single-process, in-memory); não vale em
    múltiplas réplicas. Follow-up: rate-limit compartilhado.
  - `refreshCampaignSummary` na campanha `svc` é **O(n) por envio** — o custo
    cresce com o histórico da campanha singleton.

## Primeiro consumidor

Tenant **Uniodonto do Brasil** (`cli_4f90a915-0edb-4883-b6bb-6b9372d9c231`),
integração **Uniodontos WABA** (phone `382699438268621`), template
`confirmacao_assinatura_contrato` (pt_BR, `AUTHENTICATION`, posicional `{{1}}`).
