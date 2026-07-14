# Time de agentes — WABA Collos

Fluxo de desenvolvimento adaptado do padrão **fluxo-dev** ao stack do WABA
(NestJS + Next.js 15 + PostgreSQL; deploy docker compose via `main`).
Rastreamento no **Plane** (projeto WABA Collos, workspace `collos`).

**Cada mudança nasce de uma issue no Plane e termina com doc/ADR + issue
atualizada.** Leia antes: `AGENTS.md`, `docs/decisions/`.

## Time

| Slug | Papel | Aciona quando |
|---|---|---|
| `rafa` | Eng. Backend — NestJS, services/controllers, Meta Graph, dispatch | lógica de servidor muda |
| `luan` | Eng. Frontend — Next App Router, componentes, UI | tela/componente muda |
| `bianca` | Eng. de Dados — Postgres (schema, migrations, queries), SQLite legado, blob `app_state` | dado/tabela/query muda |
| `teo` | Identidade & Acesso — auth JWT, `scope.ts`, papéis, isolamento por tenant, `ApiTokenGuard` | identidade/acesso/tenant muda |
| `gustavo` | DevOps — docker compose, CI `ci-deploy-main`, VPS, backups | infra/deploy muda |
| `samuel` | **Segurança** — revisor read-only (segredos, tokens, rules, exposição, isolamento) | **sempre**, após implementar |
| `debora` | **QA** — revisor read-only (build, comportamento, regressão, duplicação) | **sempre**, após implementar |
| `vitor` | Specs, Análise & Documentação + ADRs | etapa de escopo e **sempre** ao final |

## Fluxo (gates)

1. **Issue** no Plane (objetivo, escopo, critério de aceite).
2. **Implementar** — o(s) especialista(s) do componente. Reusar antes de criar.
3. **Segurança + QA em paralelo** — `samuel` (APROVADO/BLOQUEADO) e `debora`
   (PASSOU/FALHOU) sobre o `git diff`. Bloqueio → volta ao passo 2.
4. **Doc/ADR** — `vitor` atualiza doc afetada; decisão vira ADR em `docs/decisions/`.
5. **Fechar issue** no Plane só depois de Segurança APROVADO + QA PASSOU.

> Regras invioláveis: backup antes de prod; não alterar segredos/tokens Meta/callback
> sem necessidade; nada de reset destrutivo de banco/volumes/git; o tenant de rotas
> públicas vem sempre do token, nunca do corpo.
