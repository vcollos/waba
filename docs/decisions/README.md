# Decisões de Arquitetura (ADR) — WABA Collos

Registro leve das decisões arquiteturais do painel WABA Collos. Cada decisão é um
arquivo `NNNN-titulo.md`. Leia antes de propor mudanças estruturais — **não
reinvente decisões já tomadas**.

Rastreamento das tarefas: projeto **WABA Collos** no Plane
(`work.collos.com.br`, workspace `collos`). Fluxo adaptado do padrão fluxo-dev
(issue-first → implementar → revisar → doc/ADR → fechar), sem time local de
subagentes: correções diretas + ADR aqui + `AGENTS.md`.

| ADR | Título | Status |
|-----|--------|--------|
| [0001](0001-arquitetura-multitenant.md) | Arquitetura multi-tenant (isolamento por `clientId` + papéis) | Aceito |
| [0002](0002-inclusao-de-listas-manual-csv-api.md) | Inclusão de contatos em listas: Manual, CSV e API por token de tenant | Aceito |
| [0003](0003-telefone-unico-por-tenant.md) | Unicidade de telefone por tenant (índice composto client_id, phone_hash) | Aceito |
| [0004](0004-etiqueta-de-tenant-por-modelo.md) | Etiqueta de tenant por modelo (override sobre o tenant da integração) | Aceito |
