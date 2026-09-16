# ADR — Contas dos agentes, subtasks e tempo real

- Status: Aceito, autorizado explicitamente por Vitor em 2026-09-05.
- Data da decisão: 2026-09-05.
- Referências: pedido TDIA-4; validação técnica DOCS-7; skill global fluxo-dev.

## Contexto

O uso de labels e uma única subissue por persona não distingue trabalhos delegados nem autoria dos Worklogs. O usuário autorizou contas próprias e medição efetiva por tarefa. ADRs anteriores são preservados como histórico; esta decisão sucede somente regras incompatíveis de personas não atribuíveis e agregação por persona.

## Decisão

Aplica-se quando este escopo executa trabalho técnico com fluxo-dev, inclusive por herança da skill global. Não impõe fluxo de desenvolvimento à rotina administrativa nem inventa mapeamento de projeto Plane.

## Contas, subtasks e tempo real — política obrigatória

Versão: 2026-09-05. Decisão autorizada por Vitor neste pedido (TDIA-4; teste DOCS-7).

- Toda mudança que usa `fluxo-dev` possui issue principal no projeto/workspace confirmado. Antes de cada delegação, crie uma subtask com `parent` igual à issue principal, objetivo, aceite e responsável. Cada trabalho delegado é uma subtask: a mesma pessoa pode ter várias na mesma issue. Consulte antes para evitar duplicidade; não crie subtasks para agentes que não serão acionados.
- As personas são usuários reais atribuíveis no Plane Collos: Rafa `rafa@collos.com.br`, Luan `luan@collos.com.br`, Bianca `bianca@collos.com.br`, Téo `teo@collos.com.br`, Gustavo `gustavo@collos.com.br`, Samuel `samuel@collos.com.br` e Débora `debora@collos.com.br`. Vitor usa exclusivamente a conta existente `vitor@collos.com.br`. Resolva o UUID pelo e-mail e confirme associação ao workspace e projeto antes de atribuir; não invente UUID. Labels `agent:<slug>` são auxiliares, não substituem assignee.
- Confirme Time Tracking ativo no projeto. Persista uma sessão identificada antes do trabalho: `session_id`, issue pai, subtask, persona, runtime, início UTC e relógio monotônico. Ao terminar, persista fim UTC, fim monotônico e duração calculada. Nunca invente, estime, projete nem reconstrua timestamps retroativamente. Modelo não confirmado é `unknown`.
- Meça o intervalo observado de execução, não CPU nem tokens. Se o lead mede da delegação ao retorno, declare que inclui latência de despacho/retorno e ferramentas. Separe espera por usuário, pausas e retomadas em sessões; não some períodos sem observação. O relógio monotônico é compartilhável entre processos do mesmo host e mesmo boot; start e stop em processos distintos são válidos. Confirme a identidade do host e do boot (boot_id). Outro host ou reinício sem continuidade comprovada exige registrar a limitação e `TELEMETRIA_PENDENTE`. Tempo somado de agentes paralelos não é duração de calendário da issue nem medida isolada de qualidade/eficácia.
- Cada retomada da mesma tarefa abre nova sessão na mesma subtask. Correção de revisão/QA é sessão `retrabalho`, com origem (`seguranca`, `qa`, `build`, `integracao`, `mudanca_escopo`, `correcao_propria`, `outro`). Novo trabalho/objetivo exige nova subtask. Tipos restantes: `implementacao` e `revisao`.
- Envie o Worklog à subtask via MCP autenticado como o agente executor, usando credencial no cofre; nunca exponha senha/token em prompts, arquivos versionados, logs ou Plane. Vitor usa sua identidade existente. Assignee da subtask e `logged_by` do Worklog são campos distintos: confirme ambos por leitura posterior e UUID, não pelo texto da descrição. Se o runtime não disponibiliza autenticação por agente, registre a limitação; não registre outro autor como se fosse o executor.
- Confira o schema real de duração do MCP e a unidade retornada pela API; converta somente a duração medida, preservando precisão e unidade nos metadados. Registre `session_id`, persona, tipo/origem, issue pai, início/fim, duração medida, método/limites da medição, runtime/modelo e resultado curto. Por autorização posterior de Vitor, grave minutos inteiros arredondados ao mais próximo, com 30 segundos para cima: `floor((segundos_medidos + 30) / 60)`. Exemplos: 1m12s = 1 min; 1m32s = 2 min; abaixo de 30s = 0 min. Preserve segundos/nanossegundos exatos no journal e metadados. Zero arredondado com medição positiva não significa tempo desconhecido. Consolidados distinguem soma exata de soma arredondada; a quantização afeta tarefas curtas.
- A fonte oficial é Worklogs lido de volta por MCP/API, inclusive quando servido pela compatibilidade CE `mcp_worklogs`; não presuma visibilidade na UI Pro. Valide ID, subtask, autor e duração após gravar. Antes de retry após timeout ambíguo, consulte a sessão existente para impedir duplicidade. Não remova Worklogs no ritual normal.
- Interrupção deve preservar os metadados já conhecidos. Falha de gravação/leitura/atribuição gera `TELEMETRIA_PENDENTE` com operação e sessão exatas; não invente duração para preencher a lacuna. Trabalho técnico pode continuar quando seguro, mas telemetria não está concluída até a confirmação. Encerramento distingue entrega técnica, revisões e pendências de telemetria; não declare o fluxo integralmente concluído com tempo pendente.
- Samuel e Débora continuam read-only, cada revisão com sua subtask/sessão; Vitor continua responsável por Markdown e ADR. Preserve todos os gates de segurança e QA. Decisões aceitas permanecem históricas; alterações relevantes exigem autorização e ADR sucessor quando aplicável.

### Helper operacional global

Quando instalado e validado no host, use `~/.local/bin/plane-agent-worklog start --agent SLUG --project UUID --issue UUID --parent UUID --kind implementacao|revisao|retrabalho` antes da delegação; o retorno indica o journal. Para retrabalho, `--origin` é obrigatório: por exemplo, `plane-agent-worklog start --agent vitor --project UUID --issue UUID --parent UUID --kind retrabalho --origin integracao`. Origens permitidas: `seguranca`, `qa`, `build`, `integracao`, `mudanca_escopo`, `correcao_propria`, `outro`. O comando atual não possui flags `--runtime` ou `--model`; metadados não confirmados permanecem `unknown`, sem inventar parâmetros. Ao terminar, `plane-agent-worklog stop CAMINHO --result "resumo"`; depois `plane-agent-worklog publish CAMINHO`. O journal fica em `~/.local/state/plane-agent-worklog/`. `publish` valida identidade, parent e duração via MCP; repetir publicação usa o mesmo `session_id`, sem recalcular tempo. Separe sessões antes de aguardar usuário: o relógio corrido do helper inclui espera entre start e stop. A indisponibilidade do helper/autenticação exige pendência explícita, não comandos presumidos como executados.

## Alternativas

Manter apenas labels e autoria centralizada dificulta atribuição. Estimar duração ou usar uma sessão única por agente não atende à exigência de tempo observado.

## Consequências

Mais subtasks e sessões auditáveis; credenciais protegidas e membros confirmados em cada projeto. Duração sozinha não mede eficácia: confronte aceite, QA e retrabalho. Falta de medição é desconhecida, nunca zero. Plataformas sem acesso operacional mantêm pendência explícita.
