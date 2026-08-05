# AGENTS.md

## Objetivo

Este repositório opera um app self-hosted para campanhas e flows do WhatsApp Business.

Prioridade operacional:

1. preservar dados de campanhas, eventos e respostas
2. manter `waba.collos.com.br` e `waba-api.collos.com.br` estáveis
3. evitar regressões em webhook, sync de flows e monitoramento de campanha

## Stack e topologia

- frontend: `Next.js 15`
- backend: `NestJS`
- banco principal: `PostgreSQL 16`
- compatibilidade legado: `SQLite` local em `./data/campaign-sender.sqlite`
- deploy atual: `docker compose`
- VPS Oracle: acesso por `ssh oracle`
- path remoto do app: `/opt/apps/waba`

Domínios de produção:

- web: `https://waba.collos.com.br`
- api: `https://waba-api.collos.com.br/api`
- webhook Meta: `https://waba-api.collos.com.br/api/webhooks/meta/whatsapp`

## Multi-tenant (isolamento por tenant)

A Collos opera este painel para múltiplas Uniodontos (tenants). Regras:

- isolamento por `client_id`, imposto no **backend**, nunca só na UI
- papéis Collos (`super_admin`/`admin`) veem tudo; papéis de cliente
  (`client_admin`/`operator`/`viewer`) só o próprio tenant; `viewer` = leitura
- escopo centralizado em `apps/api/src/common/scope.ts` (`resolveClientScope`,
  `writeClientId`, `isWithinScope`, `sessionClientIds`)
- toda entidade escopável grava `client_id` via `writeClientId` e filtra leitura
  via `resolveClientScope`/`isWithinScope`
- exceção: `templates.client_id` é um **override** (etiqueta administrativa), não
  um tenant de criação — tenant efetivo do modelo =
  `template.clientId ?? integration.clientId` (ADR 0004). Etiquetar **move** o
  modelo: o tenant anterior perde a visibilidade.
- campanha: template e flow só podem ser da **integração da campanha** — a
  integração define o que pode ser usado nela (`campaigns.service.ts#create`)
- detalhes e decisões em `docs/decisions/` (ver ADR 0001, 0002 e 0004)

## API pública por token de tenant

- listas aceitam inclusão de contatos via API externa autenticada por token do
  tenant (`api_tokens`, só hash sha256 persistido; texto puro exibido uma vez)
- guard: `apps/api/src/api-tokens/api-token.guard.ts` (Authorization: Bearer)
- rotas sob `/api/public/v1`:
  - `GET/POST /lists`, `POST /lists/:id/contacts` (ingestão de contatos, ADR 0002)
  - `POST /messages` — **disparo transacional** (OTP/assinatura), envio síncrono
    fora do poller, categorias `UTILITY`/`AUTHENTICATION` (ADR 0005)
- o tenant vem **sempre** do token; nunca confiar em `clientId` do corpo
- gestão de tokens: `/api/api-tokens` (JWT; `super_admin`/`admin`/`client_admin`)

### Disparo transacional (`POST /public/v1/messages`, ADR 0005)

- envio **síncrono**, resposta com `providerMessageId` e `status: accepted`; não
  passa pelo `DispatchService` (é o 1º caminho de escrita de mensagem fora do
  poller de lote)
- rastreio reusa `campaign_messages` numa campanha singleton por integração
  `svc:<integrationId>` (status `completed`, invisível ao poller) → herda funil,
  webhook e cobrança
- `transactional_dispatches` (`UNIQUE(client_id, idempotency_key)`) só para
  idempotência (`Idempotency-Key`) + callback
- callback de saída assinado `X-Waba-Signature: sha256=HMAC(corpo,
  callback_secret)`; `callback_secret` retornado 1x na resposta
- guarda SSRF do callback em `callback-url.ts` (classificação de IP em bytes,
  pin do IP no connect, https-only, sem redirect); OTP redigido (`***`) no
  payload persistido; opt-out do tenant suprime (409); rate-limit por token
  (10/s + 300/min, in-memory por instância)

## Rastreamento (Plane)

- projeto **WABA Collos** no Plane (`work.collos.com.br`, workspace `collos`)
- fluxo adaptado do fluxo-dev: issue-first → implementar → revisar → doc/ADR →
  fechar. Sem time local de subagentes; correções diretas + ADR + este arquivo

## Regras de operação

- trate `PostgreSQL` como store operacional principal
- não trate `SQLite` como fonte de verdade de produção
- antes de qualquer mudança de produção, faça backup
- se o browser mostrar erro de CORS, assuma primeiro que pode ser `502` upstream
- não altere segredos, tokens Meta ou callback URL sem necessidade explícita
- não faça reset destrutivo de banco, volumes Docker ou histórico git

## Backup obrigatório antes de deploy

Na VPS:

```bash
ssh oracle
cd /opt/apps/waba

STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p /home/ubuntu/backups/waba/$STAMP
docker exec waba-postgres-1 pg_dump -U campaign_sender -d campaign_sender > /home/ubuntu/backups/waba/$STAMP/campaign_sender.sql
cp -f data/campaign-sender.sqlite /home/ubuntu/backups/waba/$STAMP/campaign-sender.sqlite 2>/dev/null || true
cp -f data/campaign-sender.sqlite-wal /home/ubuntu/backups/waba/$STAMP/campaign-sender.sqlite-wal 2>/dev/null || true
cp -f data/campaign-sender.sqlite-shm /home/ubuntu/backups/waba/$STAMP/campaign-sender.sqlite-shm 2>/dev/null || true
```

## Deploy padrão

```bash
ssh oracle
cd /opt/apps/waba
docker compose up -d --build api web
```

## Backfill de pricing (passo único pós-deploy do relatório de custos)

As colunas `pricing_category`/`pricing_billable`/`pricing_model` de
`campaign_messages` nascem na **migração de boot** do backend (ADR 0007). Logo, o
histórico anterior à mudança só é preenchido rodando o backfill **uma vez, APÓS o
deploy**:

```bash
ssh oracle
cd /opt/apps/waba
node scripts/backfill-pricing.mjs            # dry-run (default), só relata
node scripts/backfill-pricing.mjs --execute  # aplica
```

- casa `message_events` → `campaign_messages` por `provider_message_id`, dedup
  por wamid preferindo `billable=true`/evento mais recente
- **idempotente**: só toca linhas com `pricing_category IS NULL` — rodar de novo
  não sobrescreve
- sem isso, campanhas antigas aparecem no relatório sem custo

## Deploy automatizado por GitHub

Branch de produção:

- `main`

Workflow:

- `.github/workflows/ci-deploy-main.yml`

Comportamento do deploy automático:

1. valida `lint` e `build`
2. conecta por SSH na VPS Oracle
3. força o checkout do repositório remoto para `origin/main`
4. remove lixo `._*` e demais untracked do repo
5. executa `docker compose up -d --build api web`

Consequência operacional:

- alterações manuais dentro de `/opt/apps/waba` serão descartadas no próximo deploy do `main`
- `data/` e volumes Docker permanecem preservados

Se também precisar do proxy local versionado:

```bash
docker compose --profile edge up -d --build
```

## Validação mínima após deploy

Na VPS:

```bash
docker inspect -f '{{.RestartCount}} {{.State.Status}} {{.State.OOMKilled}}' waba-api-1
docker stats --no-stream waba-api-1 waba-web-1 waba-postgres-1
docker logs --tail 100 waba-api-1
```

Da máquina local:

```bash
curl -sS -X POST 'https://waba-api.collos.com.br/api/auth/login' \
  -H 'Content-Type: application/json' \
  --data '{"email":"<admin-email>","password":"<admin-password>"}'
```

Com token válido, validar:

- `GET /api/library/templates`
- `GET /api/library/flows`
- `GET /api/contacts?limit=50&offset=0`
- `GET /api/lists`
- `GET /api/api-tokens`
- `GET /api/dashboard/summary`
- `GET /api/results/summary`
- `GET /api/reports/campaigns` (relatório de custos; ver ADR 0007)
- `POST /api/integrations/{id}/test`
- `POST /api/integrations/{id}/sync/flows`

Sempre enviar `Origin: https://waba.collos.com.br` nos testes de CORS.

## Pontos críticos do código

- persistência e bootstrap: `apps/api/src/database/database.service.ts`
- escopo multi-tenant: `apps/api/src/common/scope.ts`
- tokens de API + ingestão pública: `apps/api/src/api-tokens/`
- assistente CSV compartilhado (fonte única): `apps/web/components/csv-import-modal.tsx`
- dispatch de campanha: `apps/api/src/campaigns/dispatch.service.ts`
- agregação/resumo de campanha: `apps/api/src/campaigns/campaigns.service.ts`
- webhook Meta: `apps/api/src/webhooks/webhooks.service.ts` — além do status,
  agora **extrai o `pricing`** de `statuses[].pricing` e grava
  `pricing_category`/`pricing_billable`/`pricing_model` em `campaign_messages`
  (try/catch, não bloqueia o status; base do relatório de custos, ADR 0007)
- relatório de custos: `apps/api/src/reports/` (`/reports/campaigns`,
  `export.csv`, `export.pdf` como HTML print-ready, `/reports/rates`,
  `/reports/settings`; reusa `results.service.ts`/`campaign-metrics.ts`)
- resultados: `apps/api/src/results/results.service.ts`
- wrapper HTTP do frontend: `apps/web/lib/api.ts`

## Bugs e riscos já conhecidos

- dispatcher ainda é inline e single-process
- webhook ainda precisa validar `X-Hub-Signature-256`
- token JWT do frontend ainda fica em `localStorage`
- polling do frontend existe e deve continuar contido
- sync de flows é operação cara; tratar timeout e carga com cuidado

## Diretriz de troubleshooting

Se houver `Failed to fetch`:

1. validar saúde do container `waba-api-1`
2. validar endpoint real com `curl` e header `Origin`
3. checar se houve `502` antes de culpar CORS
4. checar tamanho do `app_state`
5. checar contagens de `campaign_messages`, `message_events` e `flow_responses`

Consultas úteis:

```sql
select octet_length(state_json), updated_at from app_state where id = 1;
select count(*) from campaign_messages;
select count(*) from message_events;
select count(*) from flow_responses;
```

## Expectativa de documentação

Ao alterar arquitetura, deploy, persistência ou operação:

- atualizar `README.md`
- atualizar `docs/campaign-sender-spec.md`
- registrar decisões arquiteturais em `docs/decisions/` (ADR) e atualizar o índice
- manter este `AGENTS.md` alinhado com a realidade da VPS
