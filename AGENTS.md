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
- `GET /api/dashboard/summary`
- `GET /api/results/summary`
- `POST /api/integrations/{id}/test`
- `POST /api/integrations/{id}/sync/flows`

Sempre enviar `Origin: https://waba.collos.com.br` nos testes de CORS.

## Pontos críticos do código

- persistência e bootstrap: `apps/api/src/database/database.service.ts`
- dispatch de campanha: `apps/api/src/campaigns/dispatch.service.ts`
- agregação/resumo de campanha: `apps/api/src/campaigns/campaigns.service.ts`
- webhook Meta: `apps/api/src/webhooks/webhooks.service.ts`
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
- manter este `AGENTS.md` alinhado com a realidade da VPS
