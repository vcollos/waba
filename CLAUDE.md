# waba


<!-- fluxo-dev-contas-tempo-real -->
## Fluxo-dev: contas, subtasks e tempo real

Aplica-se quando este escopo executa trabalho técnico com fluxo-dev, inclusive por herança da skill global. Não impõe fluxo de desenvolvimento à rotina administrativa nem inventa mapeamento de projeto Plane.

Siga o [ADR de contas dos agentes e tempo real](docs/decisions/0010-contas-agentes-subtasks-tempo-real.md) e a skill fluxo-dev ativa. Toda tarefa delegada exige subtask prévia sob a issue principal, atribuída à conta verificada do agente. Vitor usa `vitor@collos.com.br`; os demais usam sua conta `slug@collos.com.br`. Meça sessões reais com UTC e monotônico, sem inventar, estimar ou projetar tempo; registre Worklog pelo MCP autenticado como executor e confirme `logged_by`, subtask e duração por leitura posterior. Retomada/retrabalho mantém a tarefa com nova sessão; novo trabalho exige nova subtask. Falhas ficam como `TELEMETRIA_PENDENTE`, nunca como tempo zero ou telemetria concluída. Preserve os gates de segurança/QA e o restante das instruções.
<!-- /fluxo-dev-contas-tempo-real -->
