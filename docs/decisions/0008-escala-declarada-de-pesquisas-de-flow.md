# 0008 — Escala de pesquisa vem da definição do flow, não das respostas (CSAT declarado + falha fechada)

- **Status:** Aceito
- **Data:** 2026-08
- **Contexto Plane:** WABA Collos (issue WABA-27)
- **Gate:** Segurança APROVADO (`samuel`) + QA PASSOU (`debora`) + Dados APROVADO (`bianca`)

## Contexto

Uma pesquisa NPS/CSAT real (Dental Uniodonto / Uniodonto de Campinas) foi montada
como **WhatsApp Flow estático de 4 telas** e submetida à Meta. O payload de
conclusão traz `nps` (0-10), `justificativa` (texto), `csat_comercial`,
`csat_disponibilidade`, `csat_entrega` (escala **1-5**) e `sugestao_curso`
(texto). O **JSON do flow está congelado** — já submetido —, então toda correção
teve de acontecer do lado do app.

Dois problemas apareceram aí:

**1. A escala era inferida das respostas.** `buildCsatMetric` calculava
`satisfiedThreshold = max(maxValue - 1, minValue)` sobre os valores
**observados**. Numa escala 1-5, se ninguém marcasse `5`, o corte caía para `3` e
"Neutro" passava a contar como satisfeito. No cenário real medido, isso produziu
**100% de satisfação contra os 50% corretos** — número errado com aparência de
exato, exposto ao cliente.

**2. A métrica existia e nunca era mostrada.** As métricas de pesquisa já eram
calculadas na API, mas a interface `Summary` do frontend não declarava
`surveyMetrics` — a tela de Resultados simplesmente não renderizava nada.

Complicador estrutural: em flow **multi-tela**, a ação `complete` da última tela
não recebe `${form.x}` e sim `${data.x}` — o valor chega encadeado pelas telas
anteriores. Em produção, **177 de 302 `payloadFields`** são desse tipo
(`expression`). Ler só o `complete` resolveria a minoria dos campos.

## Decisão

### 1. A faixa da escala vem do FLOW_JSON, não das respostas

O sync de flows (`meta-graph.service.ts`) passa a extrair, além do payload de
`complete`, os **componentes de entrada declarados** em cada tela
(`RadioButtonsGroup`, `Dropdown`, `CheckboxGroup`, `ChipsSelector`, `TextArea`,
`TextInput`) com as opções estáticas do `data-source` (`id` + `title`).
Persistidos em `flows.input_field_definitions_json` (coluna nova, DDL aditivo e
idempotente em `migrateTenantSchema`).

Com a escala declarada, `buildCsatMetric` deixa de inferir faixa: os valores
válidos são checados **por conjunto** (não por intervalo — a escala pode ser não
contígua) e o top-2-box sai das duas opções extremas do lado bom, não de
`max - 1`.

### 2. Flow multi-tela resolvido por travessia de grafo

O sync também persiste as **arestas de navegação** (ação `navigate` com destino
estático) em `flows.screen_transitions_json`, cada aresta carregando os
`payloadFields` que atravessa. `resolveFieldScale` caminha o grafo **para trás**,
de `${data.x}` na tela final até o componente que originou o valor.

Sem isso a entrega ficaria inerte: a maioria dos campos de produção é
`expression`. A travessia é **memoizada por nó `(tela, chave)`** — não por
caminho —, o que a torna `O(nós + arestas)`. A guarda de profundidade
(`MAX_TRANSITION_DEPTH = 64`) é guarda de pilha e **não é memoizada**, de
propósito: memoizar o resultado truncado contaminaria nós legítimos.

### 3. Orientação da escala inferida pelos rótulos, por token

Pesquisas Uniodonto em produção usam **escala invertida**
(`0_Muito_satisfeito` … `4_Muito_insatisfeito`): o top-2-box são as opções mais
**baixas**. Sem ler isso, o score mediria os insatisfeitos e os apresentaria como
satisfação.

A orientação é decidida pelos rótulos dos **dois extremos** declarados, comparando
**tokens normalizados**, nunca substring — `muito insatisfeito` contém
`satisfeito`, e um `includes` classificaria o pior rótulo da escala como
positivo. Tokenizar separa `insatisfeito` de `satisfeito`; negação explícita
("não satisfeito") inverte o sinal. Na pesquisa `atendimento` real, a detecção
por token cobre **85,8%** dos casos contra **5,8%** por substring.

Só afirma orientação quando os dois extremos têm sinal **e** são opostos.
Qualquer outra combinação (sem rótulo, rótulo neutro, mesmo sinal nos dois lados)
vira `assumed`: mantém o padrão histórico (maior = melhor) e **sinaliza na tela**.

### 4. Falhar fechado é a regra transversal

Em **qualquer** ambiguidade, a métrica cai para escala observada e sinaliza, em
vez de escolher:

- escalas divergentes para a mesma chave entre flows do recorte;
- nome de componente duplicado na mesma tela (dedup por identidade do nó cobre o
  `Form` aninhado; componentes distintos com o mesmo nome continuam ambíguos);
- caminho de entrada no grafo que não resolve, ou resolve para escala diferente;
- ciclo no grafo (nó em `RESOLVING`);
- ids de opção não inteiros (escala textual não é faixa);
- amplitude acima do teto (ids do tipo ano/código passam no teste de inteiro mas
  não são escala de pesquisa).

O princípio: **métrica que se sabe aproximada é melhor que métrica errada com
aparência de exata.**

O NPS é a exceção declarada: faixa 0-10 e os cortes são **normativos da métrica**,
nunca inferidos; a definição do flow só acrescenta rótulos.

### 5. Dois campos novos no contrato da métrica

`SurveyMetricSummary` ganha:

- **`scaleSource: 'declared' | 'observed'`** — se a faixa veio do flow ou foi
  deduzida das respostas;
- **`scaleOrientation: 'ascending' | 'descending' | 'assumed'`** — qual ponta da
  escala é a boa.

São **causas e ações distintas** na UI, e por isso dois campos e não um:

- `observed` → a faixa não veio do flow; **re-sincronizar o flow resolve**;
- `assumed` **com** escala declarada → os rótulos existem e mesmo assim não dizem
  qual ponta é a melhor; **sincronizar não resolve**, é preciso revisar as opções
  da pergunta.

A tela de Resultados (`apps/web/app/results/page.tsx`) passa a declarar
`surveyMetrics` no `Summary` e renderizar os cards, com aviso "Escala inferida",
aviso "Orientação não confirmada" e badge "Escala invertida".

### 6. Tetos defensivos (gate de segurança)

| Teto | Valor | Motivo |
|------|-------|--------|
| Opções na escala declarada | 50 | escala de pesquisa é curta |
| Amplitude da escala declarada (`max - min`) | 100 | rejeita ids ano/código |
| Opções lidas do `data-source` | 200 | Dropdown de cidades/procedimentos não é escala e não pode inchar `input_field_definitions_json`, que volta inteiro em todo `readMetaSnapshot()` |
| Componentes de entrada por flow | 500 | limita o tamanho do índice |
| Arestas de navegação por flow | 500 | limita o grafo percorrido |
| Baldes de distribuição | 100 | faixa densa observada não vira 1e9 buckets |
| Download do FLOW_JSON | 5 MB | timeout limita duração, não volume; corta por `Content-Length` e por bytes lidos |

`Math.min(...values)` foi trocado por laço: o spread estoura a pilha com volume
alto de respostas.

## Alternativas consideradas

- **Corrigir o FLOW_JSON e re-submeter à Meta.** Rejeitada — o flow já estava
  submetido e congelado, e re-submissão depende de aprovação da Meta. Além disso,
  não conserta as pesquisas já publicadas nem as respostas já coletadas: a
  correção precisa viver no app.
- **Fixar a escala 1-5 no código para campos com prefixo `csat_`.** Rejeitada —
  funciona para esta pesquisa e quebra na próxima. A convenção de nome não é
  contrato; o `data-source` do flow é.
- **Ler apenas o payload de `complete`, sem travessia de grafo.** Rejeitada —
  177 de 302 `payloadFields` em produção são `expression` (`${data.x}`). A
  entrega cobriria a minoria dos campos e pareceria funcionar nos testes de flow
  de tela única.
- **Detectar orientação por `includes` no rótulo.** Rejeitada — `muito
  insatisfeito` contém `satisfeito`; o classificador marcaria o pior ponto da
  escala como positivo, invertendo o score exatamente nos casos que importam.
  Comparação por token: 85,8% de detecção contra 5,8%.
- **Um único campo `scaleConfidence`.** Rejeitada — colapsaria duas causas com
  **ações opostas** (uma resolve sincronizando, a outra não). O operador
  precisaria adivinhar o que fazer.
- **Assumir uma orientação quando os rótulos não decidem.** Rejeitada — é
  exatamente o erro original em outra roupa. `assumed` mantém o padrão histórico
  e diz na tela que é palpite.

## Consequências

### Restrição operacional obrigatória: ordem de sync × campanha

`flows.id` é **regenerado a cada sync** (`newId()` + DELETE/INSERT), então
campanhas e respostas guardam ids que morrem no sync seguinte. Medido pela
análise de dados. Na prática:

- **Sincronize a integração ANTES de criar a campanha** — obrigatório.
- **Não sincronize entre criar a campanha e o fim da coleta.** Um sync nessa
  janela quebra **só as respostas que chegarem depois**.
- **Respostas já coletadas sobrevivem**, porque `meta_flow_id` é gravado junto e
  é estável — comprovado: **2433 de 2433** respostas de março continuam
  resolvendo.
- **Não há sync automático**: só o botão na tela de Integrações. O risco é
  humano, não de agenda.

### Efeitos no resto do sistema

- **`flows` tem duas colunas novas** (`input_field_definitions_json`,
  `screen_transitions_json`), aditivas e idempotentes. Quem alterar o sync de
  flows precisa preservar a extração — sem ela, toda métrica volta a `observed`.
- **Números de satisfação mudam depois do deploy + re-sync.** É a correção, não
  regressão: escalas 1-5 sem `5` observado estavam superestimadas, e escalas
  invertidas Uniodonto estavam medindo insatisfação como satisfação.
- **Flows não re-sincronizados continuam em `observed`.** A correção só vale
  depois de um sync que popule as colunas novas — respeitando a restrição de
  ordem acima.

### Pendências conhecidas (ticket separado, não são tarefas desta entrega)

- **Identidade estável do flow.** `flows.id` regenerado a cada sync é a causa
  raiz da restrição operacional acima; enquanto ela existir, a regra de ordem é
  contorno humano.
- **Agregação de métrica por `(flow, fieldKey)`.** Hoje a agregação é por
  `fieldKey`, então a mesma chave em flows diferentes com escalas divergentes cai
  para `observed` — falha fechada correta, mas perde precisão que a chave
  qualificada por flow recuperaria.
- **Botão de sync sem confirmação.** Um clique na tela de Integrações no meio de
  uma coleta é indistinguível de um clique deliberado.

### Gate

O caminho até a aprovação teve **dois bloqueios de segurança** — DoS por
materialização de faixa densa e explosão exponencial na travessia do grafo — e um
**P0 de dados**, todos corrigidos antes do veredito. Segurança APROVADO
(`samuel`), QA PASSOU (`debora`), Dados APROVADO (`bianca`).
