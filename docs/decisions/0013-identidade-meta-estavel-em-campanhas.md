# ADR 0013 — Identidade Meta estável nas campanhas

- Status: Aceito
- Data: 2026-09-24
- Referências: WABA-57, PEU-347, ADR 0008, ADR 0012

## Contexto

`templateCacheId` e `flowCacheId` são identificadores locais renováveis. A sincronização dos caches pode deixar campanhas concluídas com referências órfãs. Sem os IDs Meta originais, a API pública não consegue agrupar com segurança execuções do mesmo modelo e Flow. O nome da campanha não identifica o envio; o nome do template sozinho também não prova que o ID Meta histórico é o atual.

## Decisão

Campanhas novas guardam `metaTemplateId` e `metaFlowId` no momento da criação, junto dos vínculos locais existentes. A leitura pública prefere esses IDs históricos; para campanhas antigas, usa o cache da mesma integração e, quando existe, o `flow_id` do botão Flow aprovado no template. Identidade não resolvida permanece explícita como `unresolved` e não participa da consolidação.

Campanhas históricas só recebem backfill quando há evidência do vínculo original em backup e verificação do payload efetivamente enviado. O backfill é pontual, auditável e preserva os IDs locais e todas as demais propriedades. O processo exige backup novo, transação com comparação dos valores esperados e reinício da API para atualizar o cache em memória.

## Alternativas consideradas

- Agrupar pelo nome da campanha ou do template: rejeitado por permitir colisão ou recriação com outro ID Meta.
- Tratar Flow sem cache como ausência de Flow: rejeitado, pois mistura campanhas com Flow não resolvido com campanhas sem Flow.
- Criar tabela geral de mapeamento histórico: desnecessário para três registros conhecidos e mais custoso de manter agora.

## Consequências

O contrato JSON de campanha ganha dois campos opcionais, compatíveis com registros antigos. O ID Meta persiste mesmo após sincronizações futuras. Campanhas sem prova histórica continuam na visão individual até reconciliação. A API pública não expõe segredo, payload bruto ou dados pessoais adicionais.
