# 0016 — CSAT com opção explícita de não participação

- **Status:** Aceito
- **Data:** 2026-10-23
- **Autorização:** Vitor autorizou a implementação após apresentação da necessidade de complementar o ADR-0008.
- **Referências:** [ADR-0008](0008-escala-declarada-de-pesquisas-de-flow.md), PEU-384, `flows/convencao-2026-satisfacao.json`.

## Contexto

A pesquisa da convenção avalia dez palestras individualmente. Quem não participou precisa indicar essa condição sem atribuir nota. A rejeição de qualquer opção textual pelo ADR-0008 fazia a escala 1–5 com `na` cair no fallback observado, alterando o corte de satisfação quando ninguém respondia 5.

## Decisão

Complementar exclusivamente a regra de opções não numéricas do ADR-0008: ignorar na definição da escala a opção de id exato `na` e título exato `Não participei` ou `Não se aplica / Não participei`. Os demais critérios, orientação e falha fechada permanecem. O ADR original permanece preservado.

A resposta `na` permanece no registro e na cobertura da pergunta, mas não entra no numerador, denominador, média ou distribuição numérica do CSAT. Aparece como resposta ignorada no agregado. Sem respostas numéricas válidas não se publica um score. A escala 1–5 continua considerando satisfeitas somente as notas 4 e 5.

## Alternativas

- Remover a opção: força uma nota sem participação e distorce os resultados.
- Usar zero: mistura ausência com avaliação e pode corromper escalas legítimas que começam em zero.
- Ignorar qualquer texto: aceita escalas ambíguas indevidamente.

## Consequências

Mudança compatível, sem migração ou modificação das respostas salvas. Escalas invertidas e notas zero legítimas continuam válidas. Rótulos desconhecidos continuam no fallback observado. Exige atualização da API Waba; a definição de Flow precisa estar sincronizada para resolver sua escala declarada.
