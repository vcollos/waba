# API WABA Collos — guia de integração e referência técnica

- **Versão do documento:** 1.0.0
- **Versão pública da API:** v1
- **Base URL de produção:** `https://waba-api.collos.com.br/api`
- **Swagger UI pública:** `https://waba-api.collos.com.br/api/docs`
- **OpenAPI público versionado:** [`openapi/public-v1.yaml`](openapi/public-v1.yaml)

Este documento descreve a superfície HTTP implementada pelo WABA Collos. A API
tem duas audiências diferentes:

- **API pública de integração**, sob `/public/v1`, autenticada por API Token do
  tenant. É a única superfície exibida na Swagger UI pública.
- **API do painel**, autenticada por JWT de usuário e sujeita a papéis. Ela é
  documentada aqui para desenvolvimento e operação, mas não é publicada na
  Swagger aberta.

O webhook da Meta é uma terceira superfície: ele é público por necessidade,
mas autenticado por challenge ou assinatura HMAC da Meta e não deve ser usado
como API de cliente.

## 1. Começo rápido — API pública

### 1.1 Obter um API Token

Um usuário `super_admin`, `admin` ou `client_admin` cria o token no painel ou em
`POST /api/api-tokens`. O valor completo tem o formato `wba_` seguido de 48
caracteres hexadecimais e é exibido **uma única vez**. Somente o hash SHA-256 e
um prefixo de identificação são persistidos.

Guarde o valor em um gerenciador de segredos. Não o inclua em URL, logs,
capturas de tela, tickets ou código-fonte.

```bash
export WABA_API_TOKEN='wba_000000000000000000000000000000000000000000000000'
export WABA_API_BASE='https://waba-api.collos.com.br/api'
```

O valor acima é deliberadamente fictício e não autentica.

> **Atenção:** a URL de produção executa operações reais. Criar listas altera
> dados e enviar mensagens pode contatar destinatários e gerar cobrança da Meta.
> Para testes, use preferencialmente um tenant de homologação; na ausência de
> sandbox, crie um token dedicado e revogue-o ao terminar. Nunca use números de
> terceiros sem base legal e consentimento aplicáveis.

### 1.2 Criar uma lista

```bash
curl --request POST "$WABA_API_BASE/public/v1/lists" \
  --header "Authorization: Bearer $WABA_API_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{
    "name": "Assinaturas de setembro",
    "description": "Contatos integrados pelo sistema de contratos"
  }'
```

Resposta `201 Created`:

```json
{
  "id": "lst_01K58Q2D9Y2R3A4B5C6D7E8F9G",
  "clientId": "cli_01K58PZ9RH0A1B2C3D4E5F6G7H",
  "name": "Assinaturas de setembro",
  "description": "Contatos integrados pelo sistema de contratos",
  "sourceType": "api",
  "createdAt": "2026-09-15T19:45:00.000Z",
  "updatedAt": "2026-09-15T19:45:00.000Z"
}
```

### 1.3 Ingerir contatos

```bash
curl --request POST \
  "$WABA_API_BASE/public/v1/lists/lst_01K58Q2D9Y2R3A4B5C6D7E8F9G/contacts" \
  --header "Authorization: Bearer $WABA_API_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{
    "contacts": [
      {
        "firstName": "Maria",
        "lastName": "Silva",
        "institutionRepresented": "Uniodonto Campinas",
        "jobTitle": "Presidente",
        "phone": "+5519998887766",
        "email": "maria@example.com",
        "category": "assinante"
      }
    ]
  }'
```

Resposta `201 Created`:

```json
{
  "listId": "lst_01K58Q2D9Y2R3A4B5C6D7E8F9G",
  "received": 1,
  "inserted": 1,
  "updated": 0,
  "skipped": 0,
  "invalid": 0
}
```

### 1.4 Enviar uma mensagem transacional

```bash
curl --request POST "$WABA_API_BASE/public/v1/messages" \
  --header "Authorization: Bearer $WABA_API_TOKEN" \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: contrato-84721-confirmacao-v1' \
  --data '{
    "to": "+5519998887766",
    "template": "confirmacao_assinatura_contrato",
    "language": "pt_BR",
    "variables": {
      "1": "84721"
    },
    "callbackUrl": "https://integracao.example.com/webhooks/waba"
  }'
```

Resposta `200 OK`:

```json
{
  "id": "msg_01K58R4P8Q9A0B1C2D3E4F5G6H",
  "providerMessageId": "wamid.HBgMNTUxOTk5ODg4Nzc2NhUCABIYFjNFQkM0",
  "status": "accepted",
  "to": "+5519998887766",
  "callbackSecret": "whsec_000000000000000000000000000000000000000000000000"
}
```

O `callbackSecret` é fictício no exemplo e, em uso real, também é exibido uma
única vez.

## 2. Convenções gerais

### 2.1 Transporte e formato

- HTTPS é obrigatório em produção.
- JSON usa `Content-Type: application/json`, salvo uploads multipart e downloads.
- Datas e horários são strings ISO 8601 em UTC.
- IDs são opacos. Não derive tipo, tenant ou ordem a partir do texto do ID.
- Telefones devem conter DDI e ser normalizáveis para E.164, por exemplo
  `+5519998887766`.
- O backend pode ignorar propriedades JSON desconhecidas. Envie somente os
  campos documentados para evitar incompatibilidades futuras.

### 2.2 Respostas de erro

Erros do NestJS normalmente seguem este formato:

```json
{
  "statusCode": 400,
  "message": "Descrição do erro",
  "error": "Bad Request"
}
```

Algumas validações devolvem `message` estruturada, por exemplo:

```json
{
  "statusCode": 400,
  "message": {
    "message": "Variáveis obrigatórias do template ausentes",
    "missing": ["codigo"]
  },
  "error": "Bad Request"
}
```

| HTTP | Significado operacional |
|---:|---|
| `200` | Leitura, atualização ou disparo síncrono aceito. |
| `201` | Recurso, ação POST ou job criado. |
| `400` | Payload, filtro, estado ou regra de validação inválida. |
| `401` | JWT/API Token/assinatura ausente, inválido ou revogado. |
| `403` | Papel sem permissão para a operação. |
| `404` | Recurso inexistente ou fora do tenant; o mesmo código evita enumeração cross-tenant. |
| `409` | Conflito de estado, como destinatário em opt-out no disparo transacional. |
| `422` | A Meta rejeitou uma mensagem transacional. |
| `429` | Limite do canal transacional excedido. |
| `502` | Falha de comunicação com a Meta. |

### 2.3 Paginação e limites

- `GET /contacts?limit&offset`: `limit` padrão 50, mínimo 1 e máximo 250.
- `GET /campaigns/{id}?limit&offset`: mensagens com `limit` padrão 100,
  mínimo 1 e máximo 500.
- `GET /results/flow-responses?limit`: máximo 1000.
- Ingestão pública: máximo 5000 contatos por requisição.
- Mesclagem: máximo 100 contatos perdedores por requisição.
- Exportação filtrada de contatos: máximo defensivo de 200.000 registros.

Não há cursor nem cabeçalhos de paginação. As contagens e offsets fazem parte do
JSON quando o endpoint é paginado.

## 3. Autenticação, autorização e tenant

### 3.1 API Token do tenant

Todas as rotas `/api/public/v1/*` exigem:

```http
Authorization: Bearer wba_<48-hex>
```

O tenant vem exclusivamente do token. A API pública não aceita `clientId` no
corpo nem na query. Token sem tenant, revogado ou desconhecido retorna `401`.

### 3.2 JWT do painel

`POST /api/auth/login` recebe e-mail e senha e retorna um JWT válido por 12
horas. Todas as rotas do painel exigem:

```http
Authorization: Bearer <jwt>
```

### 3.3 Papéis

| Papel | Leitura do tenant | Escrita operacional | Administração Collos | Financeiro |
|---|---|---|---|---|
| `super_admin` | Todos ou tenant selecionado | Sim | Sim | Lê e edita |
| `admin` | Todos ou tenant selecionado | Sim | Sim | Lê e edita |
| `client_admin` | Somente tenants vinculados | Sim | Não | Lê; não edita tarifas/configuração |
| `operator` | Somente tenants vinculados | Sim | Não | Sem acesso |
| `viewer` | Somente tenants vinculados | Não | Não | Sem acesso |

Papéis de cliente recebem um ou mais `clientIds` no JWT. O `clientId` da query é
apenas um seletor de escopo; ele nunca amplia a autorização. Tentativas de acesso
fora do escopo retornam `404` ou conjunto vazio, conforme a operação.

### 3.4 Integrações compartilhadas

Uma conta WABA pode pertencer a vários tenants. A autorização usa os vínculos
N:N em `integration_clients`; `integrations.client_id` é apenas o tenant
principal derivado e não é fonte de autorização.

Em templates, `template.clientId` é uma etiqueta administrativa opcional. Se
presente, ela restringe o template a esse tenant; se ausente, todos os tenants
vinculados à integração podem vê-lo.

## 4. Modelo de contatos, campos, colunas e categorias

### 4.1 Campos canônicos de contato

| Campo | Tipo | Escrita | Regra |
|---|---|---|---|
| `id` | string | servidor | Identificador opaco e estável para atualização CSV. |
| `externalRef` | string/null | opcional | Referência do sistema de origem. |
| `clientId` | string/null | servidor/Collos | Tenant proprietário; nunca é aceito na API pública. |
| `clientName` | string/null | opcional | Rótulo legado/cliente representado; não concede acesso. |
| `firstName` | string | opcional | Usa `name` ou `Sem nome` como fallback. |
| `lastName` | string/null | opcional | Sobrenome. |
| `name` | string | derivado | Nome completo composto. |
| `phoneRaw` | string | derivado | Valor recebido. |
| `phoneE164` | string | derivado | Telefone normalizado. |
| `phoneHash` | string | interno | Hash usado na unicidade por tenant; não deve ser usado por integrações. |
| `email` | string/null | opcional | E-mail sem regra de verificação de entrega. |
| `category` | string/null | opcional | Categoria livre para segmentação. |
| `recordStatus` | `active`/`inactive` | opcional | Somente `active` é elegível para campanha. |
| `attributes` | objeto string→string | CSV/servidor | Campos complementares. Chaves e valores vazios são removidos. |
| `isValid` | boolean | derivado | Resultado da validação de telefone. |
| `validationError` | string/null | derivado | Motivo da invalidez. |
| `isOptedOut` | boolean | ação própria | Contato em opt-out é inelegível e bloqueia transacional. |
| `optedOutAt` | date-time/null | derivado | Momento da supressão. |
| `optOutSource` | string/null | derivado | Origem da supressão. |
| `importedAt` | date-time/null | servidor | Última ingestão/importação relevante. |
| `createdAt`, `updatedAt` | date-time | servidor | Auditoria temporal. |

### 4.2 Campos complementares públicos

A ingestão pública aceita:

- `institutionRepresented`: Uniodonto/instituição representada, até 200
  caracteres;
- `jobTitle`: cargo ou função, até 200 caracteres.

Eles são persistidos em `attributes` com essas mesmas chaves. Campo omitido ou
`null` preserva o valor anterior; string vazia também não remove o valor
existente. A instituição representada não altera `clientId`.

### 4.3 Criação de novos campos e colunas

Não existe endpoint para alterar schema, criar definição global de campo ou
criar coluna SQL. O mecanismo suportado é:

1. Na API pública, usar os campos explícitos documentados acima.
2. No CSV, colunas não mapeadas e não reservadas são gravadas como pares
   string→string em `attributes`.
3. Para promover um atributo a campo público tipado, adicionar o campo ao
   contrato em uma nova versão ou de forma retrocompatível, documentar limite e
   semântica e manter a chave anterior.

Essa regra impede que consumidores externos criem schema arbitrário ou misturem
campos de identificação com autorização multi-tenant.

### 4.4 Categorias

`contact.category` é texto livre e não possui catálogo CRUD. Use um vocabulário
estável no sistema de origem, preferencialmente minúsculo e sem dados pessoais,
por exemplo `assinante`, `cooperado` ou `prospect`. Alterar a categoria não muda
tenant, opt-out nem memberships.

Categorias de template e cobrança são diferentes:

- transacional público: somente `UTILITY` e `AUTHENTICATION`;
- `MARKETING` é recusada no canal transacional;
- tarifas reconhecem `MARKETING`, `UTILITY`, `AUTHENTICATION`, `SERVICE` e podem
  exibir `UNKNOWN` quando a Meta ainda não classificou a mensagem.

### 4.5 Catálogo dos objetos principais

Os objetos abaixo usam os campos indicados nos retornos JSON. Campos terminados
em `At` são ISO 8601 UTC; campos `...Id` são IDs opacos. Segredos cifrados,
`passwordHash`, `phoneHash` e payloads sensíveis internos não fazem parte dos
contratos de integração.

| Objeto | Campos públicos ou operacionais |
|---|---|
| `Client` | `id`, `name`, `legalName`, `cnpj`, `billingEmail`, `status`, `createdAt`, `updatedAt`, e, nas listagens, `integrationIds`, `integrationsCount` |
| `UserSession` | `id`, `email`, `name`, `role`, `clientIds` |
| `User` | campos da sessão mais `clients[{id,name}]`, `status`, `lastLoginAt`, `createdAt`, `updatedAt` |
| `Integration` | `id`, `name`, `graphApiVersion`, `graphApiBase`, `wabaId`, `phoneNumberId`, `webhookCallbackUrl`, `status`, `clientId`, `clientIds`, datas de sync/healthcheck e auditoria; nunca retorna tokens ou ciphertext |
| `List` | `id`, `clientId`, `name`, `description`, `sourceType`, `sourceFilePath`, `createdAt`, `updatedAt`; listagens adicionam contagens e categorias |
| `Contact` | os campos da seção 4.1; detalhes de lista podem incluí-lo em `members` |
| `Import` | `id`, `listId`, `fileName`, `fileSha256`, totais de linhas válidas/inválidas/duplicadas/ignoradas, `fieldMapping`, `defaults`, `status`, `createdAt` |
| `Template` | `id`, `integrationId`, `clientId`, IDs Meta, `name`, `languageCode`, `category`, `status`, `components`, descritores de variáveis/mídia/flow, `raw`, `lastSyncedAt` |
| `Flow` | `id`, `integrationId`, `metaFlowId`, `name`, `categories`, `status`, versões, preview, health, endpoint/assets, definições de payload/campos/transições, `raw`, `lastSyncedAt` |
| `Campaign` | `id`, `clientId`, `integrationId`, `name`, `mode`, IDs de template/flow/lista, `parameterMapping`, `audience`, snapshot, `sendRateMps`, `status`, agenda, resumo e datas |
| `CampaignMessage` | `id`, IDs relacionados, `phoneE164`, `status`, motivo de skip, payload redigido, IDs/erros do provedor, tentativas, timestamps de funil e campos de pricing |
| `FlowResponse` | IDs de integração/campanha/mensagem/contato/template/flow, IDs Meta, `waId`, payload processado e bruto, webhook bruto e datas |
| `PricingRate` | `id`, `clientId`, `category`, `unitPriceBrl`, `effectiveFrom`, `createdAt`, `updatedAt` |
| `ReportSettings` | `clientId`, `notaFiscalPct`, `updatedAt` |
| `AuditLog` | `id`, `actorUserId`, `action`, `entityType`, `entityId`, `metadata`, `createdAt` |

Enums centrais:

- `EntityStatus`: `active`, `inactive`;
- `Role`: `super_admin`, `admin`, `client_admin`, `operator`, `viewer`;
- `Campaign.status`: `draft`, `queued`, `sending`, `paused`, `completed`,
  `cancelled`, `failed`;
- `CampaignMessage.status`: `pending`, `accepted`, `sent`, `delivered`, `read`,
  `failed`, `skipped`, `cancelled`;
- `List.sourceType`: `csv`, `manual`, `api`.

## 5. API pública `/api/public/v1`

### 5.1 Listas

#### `GET /public/v1/lists`

Lista somente as listas do tenant do token, em ordem decrescente de criação.

Resposta `200`: array de listas com `id`, `name`, `description`, `sourceType`,
`sourceFilePath`, `createdAt`, `updatedAt`, `totalMembers`, `eligibleMembers` e
`categories`. Cada item de `categories` possui `value`, `label`,
`eligibleMembers` e `totalMembers`.

#### `POST /public/v1/lists`

| Campo | Tipo | Obrigatório | Validação |
|---|---|---:|---|
| `name` | string | não | Default `Lista via API`; trim; máximo efetivo 200. |
| `description` | string | não | Trim; máximo efetivo 2000. |

A lista nasce com `sourceType: api` e com o tenant do token.

### 5.2 Contatos da lista

#### `POST /public/v1/lists/{id}/contacts`

Faz upsert por telefone dentro do tenant e garante a associação à lista. O mesmo
telefone pode existir em tenants diferentes, mas só uma vez dentro do mesmo
tenant.

| Campo | Tipo | Obrigatório | Validação/semântica |
|---|---|---:|---|
| `contacts` | array | sim | 1 a 5000 itens. |
| `contacts[].phone` | string | sim por item | Com DDI; vazio/inválido incrementa `invalid`. |
| `contacts[].name` | string | não | Nome completo quando first/last não são fornecidos. |
| `contacts[].firstName` | string | não | Primeiro nome. |
| `contacts[].lastName` | string/null | não | Sobrenome. |
| `contacts[].institutionRepresented` | string/null | não | Até 200; preserva o anterior se omitido/vazio. |
| `contacts[].jobTitle` | string/null | não | Até 200; preserva o anterior se omitido/vazio. |
| `contacts[].email` | string/null | não | Valor de cadastro. |
| `contacts[].category` | string/null | não | Categoria livre. |

O contador `updated` indica contato existente processado; não significa
necessariamente que todos os campos mudaram. A implementação atual mantém
`skipped` no contrato, embora a rotina de upsert não o incremente.

### 5.3 Mensagens transacionais

#### `POST /public/v1/messages`

Envia sincronamente um template aprovado à Meta. Este caminho não usa o poller
de campanhas.

| Campo/header | Tipo | Obrigatório | Regra |
|---|---|---:|---|
| `Authorization` | header | sim | API Token do tenant. |
| `Idempotency-Key` | header | recomendado | Dedupe por tenant. Repetição devolve o disparo original sem reenviar. |
| `to` | string | sim | Destino normalizável para E.164. |
| `template` | string | sim | Nome exato de template aprovado. |
| `language` | string | condicional | Obrigatório se houver mais de um idioma aprovado para o nome. |
| `variables` | objeto string→string | conforme template | Chave pelo `paramName` em template NAMED ou pelo índice (`"1"`) em POSITIONAL. |
| `integrationId` | string | condicional | Obrigatório quando o tenant possui mais de uma integração ativa. |
| `callbackUrl` | URI HTTPS | não | Pública, sem redirect e aprovada pelas proteções SSRF. |

Processamento:

1. normaliza o telefone;
2. valida e fixa um IP público para o callback, se informado;
3. resolve uma integração ativa vinculada ao tenant;
4. aplica idempotência;
5. resolve nome/idioma e exige status `APPROVED`;
6. aceita somente `UTILITY` ou `AUTHENTICATION`;
7. exige todas as variáveis de body/header;
8. bloqueia destino em opt-out com `409`;
9. envia à Meta e persiste apenas o payload com valores sensíveis redigidos.

O rate limit é 10 requisições por segundo e 300 por minuto, por token e por
instância da API. Uma resposta `accepted` confirma aceitação síncrona pela Meta,
não entrega ao aparelho.

#### Callback de status

Quando `callbackUrl` é enviado, a resposta inicial contém `callbackSecret` uma
única vez. O WABA faz até três tentativas, timeout de oito segundos, sem seguir
redirect. Corpo:

```json
{
  "messageId": "msg_01K58R4P8Q9A0B1C2D3E4F5G6H",
  "idempotencyKey": "contrato-84721-confirmacao-v1",
  "to": "+5519998887766",
  "status": "delivered",
  "providerMessageId": "wamid.HBgMNTUxOTk5ODg4Nzc2NhUCABIYFjNFQkM0",
  "occurredAt": "2026-09-15T19:46:12.000Z"
}
```

Em falha, inclui:

```json
{
  "error": {
    "code": "131047",
    "title": "Re-engagement message"
  }
}
```

Assinatura:

```http
X-Waba-Signature: sha256=<hex-hmac-sha256-do-corpo-bruto>
```

Exemplo de verificação em Node.js:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWabaCallback(rawBody, receivedHeader, callbackSecret) {
  const receivedHex = String(receivedHeader ?? '').replace(/^sha256=/, '');
  if (!/^[0-9a-f]{64}$/i.test(receivedHex)) return false;

  const expected = createHmac('sha256', callbackSecret).update(rawBody).digest();
  const received = Buffer.from(receivedHex, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
```

Valide a assinatura sobre os bytes brutos antes de fazer `JSON.parse`, dedupe por
`messageId + status + occurredAt` e responda `2xx` rapidamente. A assinatura
garante integridade e autenticidade, mas não contém timestamp ou nonce próprio;
portanto, não impede replay e a idempotência no consumidor é obrigatória.

### 5.4 Resultados de campanhas da lista

Ambos os endpoints usam `Authorization: Bearer <token>` e exigem que a lista
pertença ao tenant do token. A consulta de resultados também exige campanha do
mesmo tenant e lista, antes da leitura de mensagens/respostas. Lista ou campanha
fora desse escopo retorna `404`; token ausente, inválido ou revogado retorna `401`.

#### `GET /public/v1/lists/{listId}/campaigns`

Retorna `{ listId, listName, campaigns }`, incluindo campanhas sem respostas.
Cada campanha contém `id`, `name`, `status`, `createdAt`, `startedAt`,
`finishedAt` e `counters`: `total`, `accepted`, `sent`, `delivered`, `read`,
`failed`, `responded`, `notResponded`, `presenceYes` e `presenceNo`.

#### `GET /public/v1/lists/{listId}/campaigns/{campaignId}/results`

| Query | Valores |
|---|---|
| `limit` | Inteiro 1–100; padrão 25. |
| `offset` | Inteiro 0–1.000.000; padrão 0. |
| `search` | Texto de até 200 caracteres; nome, telefone, e-mail, instituição, cargo e categoria. |
| `response` | `all`, `yes`, `no`. |
| `presence` | `all`, `yes`, `no`, `unknown`. |
| `status` | `all`, `pending`, `accepted`, `sent`, `delivered`, `read`, `failed`, `skipped`, `cancelled`. |

Filtros inválidos retornam `400`. A resposta contém `{ listId, campaign, total,
limit, offset, items }`: `total` é o total filtrado; `campaign.counters` descreve
a campanha inteira. Cada item representa uma mensagem, com:

- `messageId`, `contactId`, `name`, `firstName`, `lastName`, `phone`, `email`,
  `category`, `institutionRepresented`, `jobTitle`;
- `status`, `sentAt`, `deliveredAt`, `readAt`;
- `responded`, `respondedAt`, `presence`, `observation`;
- `answers`, lista de `{ key, label, value }`.

Aceite, envio, entrega e leitura são cumulativos nos contadores e filtros.
`providerMessageId` comprova aceite; `sentAt` comprova envio;
`deliveredAt`/`readAt` preservam entrega/leitura mesmo após status tardio.
Uma mensagem com falha posterior ao envio pode contar em `failed` e `sent`.
Resposta não equivale a entrega nem a confirmação de inscrição.

As respostas usam uma allowlist de chaves normalizadas: `presenca`,
`confirmapresenca`, `confirmacaopresenca`, `presence`, `attendance`, `observacao`,
`observacoes`, `observation`, `observations`, `atividade`, `activity`, `evento`
e `event`. Valores são escalares ou arrays curtos de strings; não são devolvidos
webhook bruto, token do Flow ou identificadores técnicos do payload. Novas
perguntas exigem extensão explícita desse contrato.

O histórico parte das mensagens, não dos membros atuais da lista. Usa a última
resposta vinculada à mensagem; na ausência desse vínculo, associa por contato
ou, sem contato, telefone, somente à mensagem mais recente correspondente.
Campos cadastrais vêm do contato atual do tenant, quando existente; o telefone
da mensagem preserva o destino do envio. Não há disparo ou sync de Flow nesta
consulta. Ver [ADR 0012](decisions/0012-resultados-campanhas-api-publica.md).

## 6. API do painel — referência de endpoints

Todas as rotas abaixo usam JWT, exceto onde indicado. `clientId` só seleciona um
tenant permitido.

### 6.1 Autenticação

| Método e rota | Papel | Request | Response |
|---|---|---|---|
| `POST /auth/login` | público | `{email, password}` | `{token, user}`; JWT expira em 12h. |
| `GET /auth/me` | autenticado | — | Sessão `{id,email,name,role,clientIds}`. |

### 6.2 Clientes e vínculos

| Método e rota | Papel | Operação |
|---|---|---|
| `GET /clients` | autenticado | Lista tenants visíveis, `integrationIds` e `integrationsCount`. |
| `POST /clients` | Collos | Cria cliente. `name` obrigatório; `status` default `active`. |
| `PATCH /clients/{id}` | Collos | Atualiza somente campos enviados. |
| `PUT /clients/{id}/integrations` | Collos | Substitui o conjunto final de integrações **desse cliente**. |

`ClientInput`: `name`, `legalName`, `cnpj`, `billingEmail`, `status`
(`active|inactive`). A API não valida formalmente CNPJ nem e-mail de cobrança.

### 6.3 Usuários

| Método e rota | Papel | Operação |
|---|---|---|
| `GET /users?search&clientId&role&status` | Collos | Lista e filtra usuários. |
| `POST /users` | Collos | Cria usuário. |
| `PATCH /users/{id}` | Collos | Edita usuário; senha vazia preserva a atual. |

`UserInput`: `name`, `email`, `role`, `clientIds[]`, `password`, `status`.
Senha nova exige ao menos 8 caracteres. E-mail deve ter formato básico válido e
ser único. Papéis Collos sempre recebem `clientIds: []`; papéis de cliente exigem
ao menos um tenant existente.

### 6.4 Integrações WABA

| Método e rota | Papel | Operação |
|---|---|---|
| `GET /integrations` | autenticado | Lista integrações visíveis sem retornar segredos. |
| `POST /integrations` | Collos | Cria ou atualiza integração e segredos. |
| `POST /integrations/{id}/test` | Collos | Testa comunicação com a Meta. |
| `PUT /integrations/{id}/clients` | Collos | Substitui o conjunto final de tenants dessa integração. |
| `POST /integrations/{id}/sync/templates` | Collos, client_admin, operator | Sincroniza templates da Meta. |
| `POST /integrations/{id}/sync/flows` | Collos, client_admin, operator | Sincroniza flows e FLOW_JSON. |

`SaveIntegrationInput`: `id?`, `name`, `graphApiBase?`, `graphApiVersion`,
`wabaId`, `phoneNumberId`, `accessToken`, `verifyToken`, `appSecret?`,
`webhookCallbackUrl?`, `clientId?`, `clientIds[]?`, `status?`.

Na edição, envie `********` para preservar um segredo. `clientIds`, quando
presente, substitui vínculos; `clientId` legado é apenas aditivo. O retorno nunca
contém ciphertext nem segredos em claro.

**Regra crítica de flows:** sincronize antes de criar a campanha e não sincronize
novamente até o fim da coleta. O ID local de flow é regenerado a cada sync;
respostas antigas sobrevivem pelo `metaFlowId`, mas respostas futuras da campanha
podem perder o vínculo local.

### 6.5 Biblioteca

| Método e rota | Papel | Operação |
|---|---|---|
| `GET /library/templates?integrationId&clientId` | autenticado | Templates visíveis, descritores, mídia e dados sincronizados. |
| `GET /library/flows?integrationId&clientId` | autenticado | Flows visíveis, campos declarados e transições. |

Templates são ordenados por `lastSyncedAt` decrescente. Flows incluem os limites
e definições extraídos do FLOW_JSON; não edite o retorno como fonte de verdade.

### 6.6 Contatos

| Método e rota | Papel | Operação/retorno |
|---|---|---|
| `GET /contacts` | autenticado | Array completo; com `limit`/`offset`, `{items,total,limit,offset}`. |
| `GET /contacts/export` | autenticado | Array JSON filtrado, até 200k; o frontend produz o CSV. |
| `POST /contacts` | exceto viewer | Cria contato e memberships. |
| `PATCH /contacts/{id}?clientId` | exceto viewer | Atualiza contato; `listIds` substitui memberships. |
| `DELETE /contacts/{id}` | exceto viewer | Exclui contato e retorna `{deleted:true}`. |
| `POST /contacts/bulk` | exceto viewer | Executa ação em massa e retorna `{affected}`. |
| `POST /contacts/merge` | exceto viewer | Mescla duplicados e retorna keeper/contagem/contato. |
| `POST /contacts/{id}/opt-out` | exceto viewer | Registra supressão manual. |
| `POST /contacts/{id}/opt-in` | exceto viewer | Remove supressão ativa. |

Filtros de `GET /contacts/export`:

- `search`: nome, telefone E.164, e-mail ou `clientName`;
- `category`: igualdade exata;
- `status`: `active` ou `inactive`;
- `valid`: `valid` ou `invalid`;
- `optOut`: `out` ou `in`;
- `listId`: membership na lista.

Ações de `POST /contacts/bulk`:

| `action` | Campo adicional | Efeito |
|---|---|---|
| `activate` / `deactivate` | — | Altera `recordStatus`. |
| `opt_out` / `opt_in` | — | Altera supressão; opt-out também cria histórico. |
| `delete` | — | Exclui contatos encontrados no escopo. |
| `assign_list` / `remove_list` | `listId` | Adiciona/remove membership. |
| `set_category` | `category` | Define ou limpa categoria. |
| `set_client` | `clientName` | Define ou limpa o rótulo legado de cliente. |

`contactIds` é obrigatório e deduplicado. Ação ou IDs desconhecidos não ampliam
o escopo. Na mesclagem, `keeperId` é preservado; `loserIds` são re-apontados nas
listas, mensagens, respostas e opt-outs antes da exclusão. Se qualquer membro
estiver em opt-out, o keeper permanece suprimido.

### 6.7 Listas

| Método e rota | Papel | Operação/retorno |
|---|---|---|
| `GET /lists?clientId` | autenticado | Listas com contagens e categorias. |
| `GET /lists/{id}?clientId` | autenticado | Lista com `members`. |
| `POST /lists` | exceto viewer | Cria lista manual. |
| `PATCH /lists/{id}?clientId` | exceto viewer | Atualiza nome/descrição. |
| `DELETE /lists/{id}?clientId&deleteContacts=true` | exceto viewer | Exclui lista e opcionalmente órfãos seguros. |
| `DELETE /lists/{id}/members/{contactId}?clientId` | exceto viewer | Remove membership sem excluir contato. |

Ao excluir lista, o default é preservar contatos. Com `deleteContacts=true`, só
são apagados membros do mesmo tenant que ficariam órfãos e que não tenham
mensagens, respostas de flow ou opt-out. O retorno é
`{id, contactsDeleted, contactsKept}`.

### 6.8 Importação e atualização por CSV

| Método e rota | Papel | Content-Type | Operação |
|---|---|---|---|
| `POST /contacts/imports/csv/preview` | exceto viewer | multipart | Detecta headers, amostra e mapeamento. |
| `POST /contacts/imports/csv/plan` | exceto viewer | multipart | Dry-run de insert/update, sem escrita. |
| `POST /contacts/imports/csv` | exceto viewer | multipart | Inicia job assíncrono. |
| `GET /contacts/imports/csv/jobs/{id}` | autenticado | — | Consulta job em memória. |

Campo multipart `file` é obrigatório. Campos textuais adicionais:

- `mapping`: JSON cujas chaves são campos importáveis e valores são headers;
- `clientId`: tenant ativo para Collos; papel de cliente é forçado ao próprio;
- `listName`: nome da lista no modo inserção;
- `defaults`: JSON com `clientName`, `category`, `status`;
- `overwriteExisting`: string `false` para impedir overwrite no modo inserção;
  qualquer outro valor/ausência mantém o default verdadeiro.

Campos mapeáveis:

| Chave | Obrigatório | Aliases reconhecidos |
|---|---:|---|
| `id` | não | `id`, `id_cadastro`, `cadastro_id`, `contato_id`, `contact_id` |
| `clientName` | não | `cliente`, `client`, `empresa`, `contratante` |
| `firstName` | não | `nome`, `primeiro_nome`, `primeiro nome`, `first_name`, `first name` |
| `lastName` | não | `sobrenome`, `ultimo_nome`, `último nome`, `last_name`, `last name` |
| `name` | não | `contato`, `nome_completo`, `nome completo`, `name`, `responsavel`, `titular` |
| `phone` | sim no insert | `telefone`, `celular`, `whatsapp`, `fone`, `phone`, `mobile` |
| `category` | não | `categoria`, `category`, `segmento`, `tag` |
| `status` | não | `status`, `situacao`, `situação`, `ativo`, `inativo` |
| `email` | não | `email`, `e-mail`, `mail` |
| `externalRef` | não | `codigo`, `código`, `external_ref`, `referencia`, `referência` |

Regras:

- aceita vírgula ou ponto e vírgula, BOM UTF-8, linhas vazias e quantidades de
  colunas irregulares;
- headers vazios viram `coluna_N`; duplicados recebem sufixo `_2`, `_3`, etc.;
- sem coluna `id` mapeada, o modo é `insert` e exige telefone mais nome ou nome
  completo;
- com `id`, o modo é `update`, casa pelo ID do tenant e permite corrigir telefone;
- célula vazia no modo update preserva o valor existente;
- ID ausente/desconhecido no tenant cria novo contato com novo ID interno;
- conflito de telefone é contado e não aborta o lote;
- colunas extras não vazias viram `attributes`;
- `valido`, `opt_out`, `situacao_falha`, `situacao_nao_lida`, `listas`,
  `criado_em`, `atualizado_em` são colunas reservadas e ignoradas no round-trip;
- status `inativo`, `inactive`, `desativado` e `desligado` vira `inactive`; os
  demais valores viram `active`.

O endpoint de preview retorna `fileName`, `headers`, `totalRows`, até cinco
`sampleRows`, `recommendedMapping` e `availableFields`. O plan retorna
`{mode,total}` e, em update, `updated`, `created`, `unchanged`, `conflicts`,
`invalid`. O job retorna `id`, `status`, `mode`, progresso e, ao final, lista e
registro de import ou `updateSummary`.

Jobs ficam em memória da instância: faça polling logo após criar; restart ou
troca de réplica pode tornar o ID indisponível.

### 6.9 Campanhas

| Método e rota | Papel | Operação |
|---|---|---|
| `GET /campaigns?clientId` | autenticado | Lista campanhas com funil, template e lista. |
| `GET /campaigns/{id}?limit&offset` | autenticado | Detalhe e mensagens paginadas. |
| `GET /campaigns/{id}/export.csv?clientId` | autenticado | CSV por destinatário. |
| `POST /campaigns` | exceto viewer | Cria rascunho e prepara mensagens. |
| `POST /campaigns/{id}/start` | exceto viewer | Enfileira campanha elegível. |
| `POST /campaigns/{id}/pause` | exceto viewer | Pausa. |
| `POST /campaigns/{id}/resume` | exceto viewer | Retoma se houver pendentes/falhas. |
| `POST /campaigns/{id}/retry-failed` | exceto viewer | Reagenda mensagens falhas. |
| `POST /campaigns/{id}/retry-unanswered-flow` | exceto viewer | Reenvia flow a entregues/lidos sem resposta. |
| `DELETE /campaigns/{id}` | exceto viewer | Exclui rascunho ou campanha terminal sem envio efetivo. |

A exclusão é aceita para campanhas em `draft` e para campanhas em
`completed`, `failed` ou `cancelled` quando nenhuma mensagem permanece nos
estados `pending`, `accepted`, `sent`, `delivered` ou `read`. Campanhas em processamento
(`queued`, `sending` ou `paused`) e qualquer campanha com histórico efetivo de
envio são protegidas, mesmo que o cliente tente chamar a rota diretamente.
Quando elegível, a operação remove a campanha e seus dados operacionais
relacionados (`campaign_messages` e eventos de mensagem). A exclusão é recusada
se existir qualquer resposta de flow, para nunca apagar dados de pesquisa. A
elegibilidade é revalidada na mesma transação da limpeza; webhooks e reenvios
concorrentes atualizam somente mensagens ainda existentes e não recriam linhas
removidas. O registro de auditoria preserva o estado anterior e a quantidade de
mensagens removidas. A interface solicita confirmação antes da chamada.

`CreateCampaignInput`:

- `name`, `integrationId`, `listId`, `mode` são obrigatórios;
- `mode`: `template`, `template_flow` ou `session_flow`;
- `templateCacheId`, `flowCacheId`, `clientId`, `sendRateMps`,
  `parameterMapping`, `audience` são opcionais;
- `sendRateMps` é limitado entre 1 e 80, default 20;
- template e flow devem pertencer à mesma integração da campanha.

`parameterMapping` usa chaves `componentType:placeholderIndex`, como `body:1`, e
fontes:

```json
{
  "body:1": { "type": "contact_field", "key": "firstName" },
  "body:2": { "type": "contact_field", "key": "attributes.numeroContrato" },
  "header:1": { "type": "static", "value": "https://cdn.example.com/doc.pdf" }
}
```

Para novas campanhas, use `static` ou `contact_field`. As chaves canônicas de
`contact_field` são `name`, `firstName`, `lastName`, `phoneE164`, `email`,
`category`, `clientName` e `externalRef`; colunas adicionais usam
`attributes.<chave>`. A interface apresenta somente campos existentes na lista
selecionada. Os tipos `contact_name`, `contact_phone`, `contact_email` e
`contact_attribute` permanecem aceitos para compatibilidade com campanhas
salvas anteriormente.

`audience` suporta:

- `mode`: `all`, `fixed_count`, `percentage`;
- `fixedCount` mínimo 1 quando aplicável;
- `percentage` entre 1 e 100;
- `category` exata;
- `orderMode`: `field` ou `random`;
- `orderField`: `clientName`, `firstName`, `lastName`, `name`, `category`,
  `phoneE164`, `importedAt`, `createdAt`;
- `orderDirection`: `asc` ou `desc`;
- `resendPolicy`: `all`, `not_delivered`, `not_read`;
- `uniqueWhatsAppOnly`: boolean.

Só entram contatos `active`, válidos e fora de opt-out.

### 6.10 Dashboard e resultados

| Método e rota | Papel | Operação |
|---|---|---|
| `GET /dashboard/summary?clientId&from&to` | autenticado | KPIs, campanhas recentes e top tenants. |
| `GET /results/flow-responses?...` | autenticado | Respostas enriquecidas; limit até 1000. |
| `GET /results/summary?clientId` | autenticado | Funil, timeline, erros, distribuições e NPS/CSAT. |
| `GET /results/campaigns?clientId` | autenticado | Campanhas com respostas. |
| `GET /results/campaigns/{id}/table?clientId` | autenticado | Tabela crua, payloads como colunas. |
| `GET /results/campaigns/{id}/table.csv?...` | autenticado | CSV filtrado por `respondeu`, `situacao`, `search`. |
| `GET /results/flow-responses/export.csv?...` | autenticado | CSV geral ou achatado por flow. |

Filtros de flow responses: `campaignId`, `flowCacheId`, `flowName`, `contactId`,
`limit`, `clientId`.

Métricas NPS sempre usam 0–10 e cortes normativos. Métricas CSAT usam a escala
declarada no FLOW_JSON quando inequívoca; caso contrário usam valores observados
e retornam `scaleSource: observed`. `scaleOrientation` é `ascending`,
`descending` ou `assumed`.

### 6.11 Relatórios financeiros

Leitura: `super_admin`, `admin`, `client_admin`. Escrita: somente Collos.

| Método e rota | Papel | Operação |
|---|---|---|
| `GET /reports/campaigns?from&to&clientId` | admin financeiro | Relatório consolidado JSON. |
| `GET /reports/campaigns/export.csv?...` | admin financeiro | CSV. |
| `GET /reports/campaigns/export.pdf?...` | admin financeiro | PDF real; flags `mostrarGlossario`, `mostrarIds`. |
| `GET /reports/rates?clientId` | admin financeiro | Tarifas atuais e fallback global. |
| `POST /reports/rates` | Collos | Upsert por `(clientId, category)`. |
| `GET /reports/settings?clientId` | admin financeiro | Percentual de nota fiscal. |
| `PUT /reports/settings` | Collos | Atualiza `notaFiscalPct`. |

`from` date-only começa em `00:00:00.000Z`; `to` date-only termina em
`23:59:59.999Z`. `from > to` retorna `400`. Flags de PDF são ligadas por default;
somente `false`, `0` ou `no` desligam.

Tarifas são valores atuais em BRL, sem vigência histórica. Alterar uma tarifa
recalcula relatórios passados e futuros. Custo total = subtotal + percentual de
nota fiscal. Categoria sem tarifa tem custo zero e `missingRate: true`.

### 6.12 API Tokens

| Método e rota | Papel | Operação |
|---|---|---|
| `GET /api-tokens?clientId` | Collos/client_admin | Lista metadados, nunca o token completo. |
| `POST /api-tokens` | Collos/client_admin | Cria e retorna o token uma vez. |
| `POST /api-tokens/{id}/revoke` | Collos/client_admin | Revogação imediata e idempotente. |

`POST` aceita `name` e `clientId`; papéis de cliente são forçados ao próprio
tenant. O retorno de listagem contém `id`, `clientId`, `name`, `tokenPrefix`,
`lastUsedAt`, `revokedAt`, `createdAt`, `updatedAt`.

### 6.13 Administração de tenants e auditoria

| Método e rota | Papel | Operação |
|---|---|---|
| `GET /admin/tenants/overview` | Collos | Visão de clientes, listas, campanhas e templates. |
| `POST /admin/tenants/transfer/lists` | Collos | Move listas e deduplica contatos no destino. |
| `POST /admin/tenants/transfer/campaigns` | Collos | Reatribui campanhas. |
| `POST /admin/tenants/transfer/templates` | Collos | Define/limpa etiqueta de template. |
| `GET /audit?...` | Collos | Até 500 eventos, mais recentes primeiro. |

Bodies de transferência usam `listIds[]`, `campaignIds[]` ou `templateIds[]` e
`clientId`. `clientId: null` representa pool compartilhado; para template, limpa
a etiqueta e volta a herdar os tenants da integração.

Filtros de auditoria: `actorUserId`, `action`, `entityType`, `from`, `to`.

## 7. Webhook da Meta

### `GET /webhooks/meta/whatsapp`

Challenge da Meta com `hub.mode`, `hub.verify_token`, `hub.challenge`. Retorna o
challenge em texto com `200` quando `mode=subscribe` e o verify token casa com
uma integração; caso contrário retorna `403`.

### `POST /webhooks/meta/whatsapp`

Exige `X-Hub-Signature-256: sha256=<hex>`. A assinatura é calculada sobre o corpo
bruto usando o `appSecret` da integração identificada por WABA ID ou phone number
ID. Assinatura ausente/malformada, integração desconhecida ou segredo ausente
retorna `401` antes do processamento.

O handler persiste eventos, atualiza status/pricing, processa respostas de flow e
aciona callbacks transacionais. Consumidores externos não devem chamar esta rota.

## 8. Swagger UI pública

A página já está disponível em:

`https://waba-api.collos.com.br/api/docs`

O documento JSON gerado está em:

`https://waba-api.collos.com.br/api/docs-json`

Em 15/09/2026, ambos responderam `200`; o contrato publicado contém apenas:

- `GET /api/public/v1/lists`;
- `POST /api/public/v1/lists`;
- `POST /api/public/v1/lists/{id}/contacts`;
- `POST /api/public/v1/messages`.

### 8.1 Testar com token

1. Abra a Swagger.
2. Clique em **Authorize**.
3. Cole somente o token `wba_...`; não escreva `Bearer` no campo.
4. Clique em **Authorize** e feche o modal.
5. Abra uma operação, use **Try it out**, preencha o payload e execute.

A configuração vigente usa `persistAuthorization: false`: o botão **Authorize**
continua funcionando durante a página aberta, mas a credencial não é retida
para a próxima sessão. Em computador compartilhado, ainda é recomendável
revogar o token dedicado após o teste e fechar a sessão.

Não há sandbox pública documentada atualmente. O botão **Try it out** usa
produção: `POST /lists` persiste dados e `POST /messages` pode enviar mensagem e
gerar cobrança. Use token dedicado, dados sintéticos e destinatário controlado.

### 8.2 Configuração de referência no NestJS

A configuração vigente usa `@nestjs/swagger`, `DocumentBuilder`, Bearer scheme
nomeado `token`, servidor de produção e `persistAuthorization: false`. O passo
decisivo é filtrar o documento antes de publicar:

```ts
const config = new DocumentBuilder()
  .setTitle('Uniodonto WABA — API de Disparo')
  .setVersion('1.0')
  .addServer('https://waba-api.collos.com.br')
  .addBearerAuth(
    { type: 'http', scheme: 'bearer', bearerFormat: 'wba_...' },
    'token',
  )
  .build();

const document = SwaggerModule.createDocument(app, config);
document.paths = Object.fromEntries(
  Object.entries(document.paths).filter(([path]) => path.startsWith('/api/public/')),
);

SwaggerModule.setup('api/docs', app, document, {
  customSiteTitle: 'Uniodonto WABA — API',
  swaggerOptions: { persistAuthorization: false },
});
```

Não sirva a especificação do painel na rota pública. Se uma documentação interna
interativa for necessária, publique-a em URL separada protegida por SSO/VPN e
gere um documento OpenAPI separado.

Filtrar `document.paths` é o gate mínimo vigente. Para defesa em profundidade,
gere o documento a partir de um módulo público isolado ou remova de
`components.schemas`, `components.parameters` e `tags` tudo o que não é
referenciado pelos paths públicos. Mesmo sem endpoint administrativo, um schema
interno pode revelar nomes de campos ou estruturas desnecessárias. O CI deve
validar paths **e** components permitidos.

### 8.3 Controles para exposição pública

- HTTPS e HSTS;
- Swagger e chamadas no mesmo origin, compatível com `connect-src 'self'`;
- somente paths `/api/public/*`;
- somente components alcançáveis a partir desses paths, com allowlist no CI;
- nenhum valor de token, secret ou payload real embutido em examples;
- `Cache-Control: no-store` recomendado para a página e o JSON do contrato;
- rate limit e observabilidade por endpoint sem registrar Authorization;
- CSP liberada apenas em `/api/docs`, mantendo Helmet estrito no restante;
- homologação automática que falha se um path não público aparecer no JSON.

Exemplo de gate:

```bash
curl --fail --silent https://waba-api.collos.com.br/api/docs-json \
  | node -e '
      let raw="";
      process.stdin.on("data", c => raw += c);
      process.stdin.on("end", () => {
        const paths = Object.keys(JSON.parse(raw).paths || {});
        const leaked = paths.filter(p => !p.startsWith("/api/public/"));
        if (leaked.length) {
          console.error("Paths não públicos na Swagger:", leaked);
          process.exit(1);
        }
      });
    '
```

## 9. Versionamento e manutenção

- A versão major está na URL (`/public/v1`). Mudança incompatível exige `/v2`.
- Mudanças aditivas opcionais podem permanecer em v1, com OpenAPI e exemplos
  atualizados no mesmo pull request.
- Não remova enum value, campo, status ou semântica existente sem versão major e
  janela de migração.
- Trate `docs/openapi/public-v1.yaml` como contrato revisável em código.
- Compare o YAML versionado com `/api/docs-json` no CI. Divergência deve falhar a
  entrega ou exigir atualização consciente.
- Mantenha exemplos executáveis com valores sintéticos e teste-os contra ambiente
  de homologação, nunca com contatos ou tokens reais.
- Registre alteração de autenticação, tenant, persistência, deploy ou webhook em
  ADR. Mudança puramente textual que não altera decisão não exige novo ADR.
- Inclua `Sunset` e link de migração ao descontinuar versão; mantenha período de
  convivência mensurável.
- Changelog recomendado: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`,
  `Security`, associado ao identificador Plane.

### Checklist de publicação

1. validar YAML e referências locais;
2. executar lint/build da API;
3. confirmar que nenhum example contém segredo ou PII;
4. confirmar que Swagger pública só contém `/api/public/*`;
5. testar token válido, inválido e revogado e confirmar que a UI não o persiste;
6. testar idempotência e rate limit;
7. validar callback com corpo bruto e assinatura incorreta/correta;
8. conferir CORS com `Origin: https://waba.collos.com.br`;
9. publicar junto da versão que implementa o contrato;
10. registrar data, versão e responsável pela revisão.
