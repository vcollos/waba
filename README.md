# Campaign Sender Pilot

Piloto self-hosted para operar campanhas com a WhatsApp Business Platform usando apenas APIs oficiais da Meta.

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
  - auditoria e persistência em arquivo JSON

- `apps/web`: frontend Next.js com:
  - login
  - dashboard
  - cadastro de integração
  - importação de contatos/listas
  - biblioteca de templates/flows
  - criação e monitoramento básico de campanhas

## Limites atuais do piloto

- persistência em `SQLite` local
- dispatcher inline em processo único
- uso real de campanha depende de integração Meta válida e sync prévio de templates/flows
- templates com componentes muito específicos além de placeholders textuais ainda exigem evolução do `payloadBuilder`

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

- `api`
- `web`
- `caddy`

Suba assim:

```bash
docker compose up -d --build
```

Validação rápida:

```bash
docker compose ps
curl -I http://localhost:4310
curl -I http://localhost:4311/api/dashboard/summary
```

Observações:

- o `web` agora recebe `NEXT_PUBLIC_API_BASE_URL` no `build` e no runtime
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

## Próximos passos recomendados

1. endurecer auth para sessão HTTP-only
2. mover dispatch para BullMQ/Redis
3. ampliar `payloadBuilder` para mais tipos de componentes de template
4. adicionar página detalhada de campanha com eventos por mensagem
5. adicionar RBAC mais granular

## Cloudflare Tunnel recomendado

Para o seu cenário local com acesso externo:

- `waba.collos.com.br` -> `http://localhost:4310`
- `waba-api.collos.com.br` -> `http://localhost:4311`

Webhook Meta:

- `https://waba-api.collos.com.br/api/webhooks/meta/whatsapp`
