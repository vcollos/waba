# Campaign Sender Pilot

Piloto self-hosted para operar campanhas com a WhatsApp Business Platform usando apenas APIs oficiais da Meta.

## Estado atual da produção

Em `2026-04-02`, a produção validada está rodando em uma VPS Oracle Linux/Ubuntu com:

- frontend em `https://waba.collos.com.br`
- API em `https://waba-api.collos.com.br/api`
- deploy por `docker compose` no path `/opt/apps/waba`
- `PostgreSQL 16` como persistência operacional principal
- `SQLite` residual apenas para compatibilidade e bootstrap legado

Incidente resolvido em `2026-04-02`:

- o `Failed to fetch` no browser era sintoma de `502` upstream
- a causa raiz estava no backend: estado operacional grande demais sendo regravado como JSON monolítico
- o hot path de campanhas, eventos, respostas de flow, opt-out e auditoria foi movido para tabelas Postgres dedicadas
- a API voltou a responder com CORS correto em produção

## O que já está implementado

- `apps/api`: backend NestJS com:
  - login por credencial de ambiente
  - cadastro de integração Meta com segredos cifrados em repouso
  - sincronização de templates e flows
  - importação CSV de contatos
  - listas e opt-out manual
  - criação de campanhas
  - dispatch inline com rate limit simples
  - webhook de status e opt-out por palavra-chave
  - persistência operacional em `PostgreSQL`
  - compactação de `app_state` para evitar crescimento explosivo em produção

- `apps/web`: frontend Next.js com:
  - login
  - dashboard
  - cadastro de integração
  - importação de contatos/listas
  - biblioteca de templates/flows
  - criação e monitoramento básico de campanhas
  - retry leve para `GET` em `502/503/504`
  - polling reduzido nas telas operacionais

## Limites atuais do piloto

- dispatcher inline em processo único
- ausência de fila externa (`Redis/BullMQ`) e lock distribuído
- validação de assinatura `X-Hub-Signature-256` do webhook ainda pendente
- uso de `localStorage` para token JWT ainda é provisório
- uso real de campanha depende de integração Meta válida e sync prévio de templates/flows
- templates com componentes muito específicos além de placeholders textuais ainda exigem evolução do `payloadBuilder`
- `SQLite` ainda existe como camada de compatibilidade local, mas não deve ser tratado como store primária de produção

## Como rodar localmente

1. Copie `.env.example` para `.env`
2. Ajuste `ADMIN_*`, `JWT_SECRET`, `APP_ENCRYPTION_KEY`
   Se você preencher `META_*`, a integração é criada/atualizada automaticamente no startup.
3. Instale dependências:

```bash
npm_config_strict_ssl=false npm install
```

Observação:

- nesta máquina o `npm` exigiu `npm_config_strict_ssl=false` por erro de certificado do registry (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`)

4. Suba a API:

```bash
npm --workspace @campaign-sender/api run dev
```

5. Em outro terminal, suba o frontend:

```bash
npm --workspace @campaign-sender/web run dev
```

6. Acesse:

- web: `http://localhost:4310`
- api: `http://localhost:4311/api`

## Como rodar com Docker

O repositório já tem `docker-compose.yml` e Dockerfiles para:

- `postgres`
- `api`
- `web`
- `caddy`

Suba assim:

```bash
docker compose up -d --build
```

Se quiser subir também o proxy `caddy` do repositório:

```bash
docker compose --profile edge up -d --build
```

Validação rápida:

```bash
docker compose ps
docker compose exec postgres pg_isready -U campaign_sender -d campaign_sender
curl -I http://localhost:4310
curl -I http://localhost:4311/api/dashboard/summary
```

Observações:

- o `web` agora recebe `NEXT_PUBLIC_API_BASE_URL` no `build` e no runtime
- a API usa `API_NODE_OPTIONS=--max-old-space-size=8192` por padrão
- os serviços estão com `restart: unless-stopped`
- depois do primeiro `docker compose up -d`, eles voltam automaticamente quando o Docker Desktop subir

No macOS, para isso funcionar após reinício da máquina, você ainda precisa deixar o Docker Desktop iniciando no login.

Credenciais default do piloto:

- email: `admin@example.com`
- senha: `admin123`

## Smoke tests já validados

- `POST /api/auth/login`
- `GET /api/dashboard/summary`
- `POST /api/integrations`
- `POST /api/contacts/imports/csv`
- `GET /api/lists`
- `GET /api/contacts`
- `GET /api/webhooks/meta/whatsapp` para `hub.challenge`
- `POST /api/webhooks/meta/whatsapp` para inbound `PARAR`

Smoke tests validados em produção em `2026-04-02`:

- `POST https://waba-api.collos.com.br/api/auth/login`
- `POST https://waba-api.collos.com.br/api/integrations/{id}/test`
- `POST https://waba-api.collos.com.br/api/integrations/{id}/sync/flows`
- `GET https://waba-api.collos.com.br/api/library/templates`
- `GET https://waba-api.collos.com.br/api/library/flows`
- `GET https://waba-api.collos.com.br/api/contacts?limit=50&offset=0`
- `GET https://waba-api.collos.com.br/api/lists`
- `GET https://waba-api.collos.com.br/api/results/summary`
- `GET https://waba-api.collos.com.br/api/results/flow-responses?limit=20&offset=0`

## Deploy na VPS Oracle

Produção atual:

- host: alias SSH `oracle`
- path do app: `/opt/apps/waba`
- domínio web: `https://waba.collos.com.br`
- domínio API: `https://waba-api.collos.com.br`

Sequência segura de deploy:

```bash
ssh oracle
cd /opt/apps/waba

# backup antes de mexer
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p /home/ubuntu/backups/waba/$STAMP
docker exec waba-postgres-1 pg_dump -U campaign_sender -d campaign_sender > /home/ubuntu/backups/waba/$STAMP/campaign_sender.sql

# rebuild
docker compose up -d --build api web

# saúde
docker inspect -f '{{.RestartCount}} {{.State.Status}} {{.State.OOMKilled}}' waba-api-1
docker stats --no-stream waba-api-1 waba-web-1 waba-postgres-1
```

## Troubleshooting rápido

Se o browser mostrar `Failed to fetch` ou erro de CORS:

1. valide a API primeiro; CORS aqui normalmente é sintoma de `502`
2. teste login e endpoints com `curl` usando header `Origin: https://waba.collos.com.br`
3. verifique `docker inspect` e `docker logs waba-api-1`
4. confira se `POST /api/integrations/{id}/sync/flows` responde `201`
5. confirme que `app_state` não voltou a crescer demais no Postgres

Consulta útil em produção:

```sql
select octet_length(state_json), updated_at from app_state where id = 1;
select count(*) from campaign_messages;
select count(*) from message_events;
select count(*) from flow_responses;
```

## Próximos passos recomendados

1. validar assinatura do webhook da Meta com `META_APP_SECRET`
2. mover dispatch para fila externa com idempotência cross-instance
3. encerrar dependências residuais de `SQLite`
4. endurecer auth para sessão HTTP-only
5. ampliar `payloadBuilder` para mais tipos de componentes de template
6. adicionar página detalhada de campanha com eventos por mensagem
7. adicionar RBAC mais granular

## Cloudflare Tunnel recomendado

Para o seu cenário local com acesso externo:

- `waba.collos.com.br` -> `http://localhost:4310`
- `waba-api.collos.com.br` -> `http://localhost:4311`

Webhook Meta:

- `https://waba-api.collos.com.br/api/webhooks/meta/whatsapp`
