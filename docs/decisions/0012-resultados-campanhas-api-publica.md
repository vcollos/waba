# 0012 — Resultados de campanhas pela API pública de tenant

- Status: Aceito no escopo de leitura autorizado explicitamente por Vitor.
- Data: 2026-09-17.
- Referências: WABA-56, PEU-264 e PEU-268.

## Contexto

O portal de eventos precisa acompanhar os destinatários e as respostas de Flow
das campanhas de sua lista vinculada. A API pública já autentica o tenant para
listas e ingestão, mas os resultados existentes dependem de sessão interna.
Listar somente campanhas com respostas omite campanhas ainda sem retorno.

## Decisão

1. Adicionar apenas os GETs de consulta abaixo ao controller público existente,
   protegido por `ApiTokenGuard`:
   - `/public/v1/lists/{listId}/campaigns`;
   - `/public/v1/lists/{listId}/campaigns/{campaignId}/results`.
2. Resolver o tenant pelo token, exigir que a lista pertença a esse tenant e
   que a campanha pertença à mesma lista e tenant, antes de ler mensagens ou
   respostas. O `client_id` da integração compartilhada não autoriza acesso:
   o vínculo N:N do ADR-0009 não transforma campanhas de tenants diferentes em
   dados compartilhados.
3. Incluir campanhas sem respostas. Construir destinatários pelos registros de
   mensagens, independentemente dos membros atuais da lista. Enriquecer os sete
   campos de identificação com contatos do mesmo tenant; preservar o telefone
   registrado na mensagem como destino histórico.
4. Associar a resposta mais recente da mesma campanha e integração por mensagem;
   sem vínculo de mensagem, usar contato e, quando não houver contato, telefone.
   O fallback é atribuído à mensagem mais recente daquele contato/telefone,
   evitando multiplicar uma resposta por várias mensagens.
5. Calcular aceite, envio, entrega e leitura como evidências cumulativas.
   Timestamps de entrega/leitura preservam etapas comprovadas mesmo quando o
   status corrente retrocede. Resposta é uma dimensão separada. Presença só
   recebe classificação positiva ou negativa para valores reconhecidos.
6. Retornar um contrato explícito de identificação, situação, datas e respostas
   de negócio permitidas; não expor registros internos completos, webhook bruto,
   credenciais, CPF ou token de Flow. A lista de chaves de resposta permitidas
   deve ser estendida explicitamente para novas perguntas.
7. Paginar destinatários com `limit` de 1 a 100 (padrão 25) e `offset` validado.
   Busca e filtros por situação, resposta e presença alteram a tabela, enquanto
   os contadores continuam representando a campanha inteira.
8. Reutilizar a persistência existente em PostgreSQL. Não migrar dados, disparar
   mensagens, alterar coleta ou sincronizar Flows para produzir o relatório.

## Alternativas

- Reutilizar o endpoint interno de tabela bruta: mistura o contrato externo com
  payloads internos e não dispensa validar tenant/lista/campanha.
- Determinar tenant pela integração: incorreto para contas compartilhadas.
- Consultar apenas os membros atuais da lista: perderia o histórico de envios.
- Replicar respostas no consumidor: amplia persistência e sincronização sem
  necessidade para uma consulta manual.

## Consequências e limites

- O token de tenant existente também autoriza estas leituras; não há novo
  segredo nem permissão global sobre outros tenants.
- Campos cadastrais do contato são atuais, não um snapshot completo no envio.
  Destinatário sem contato atual continua na consulta, com identificação ausente.
- A linha e os contadores contam mensagens. Campanhas distintas e mensagens
  repetidas não constituem uma contagem de pessoas únicas.
- O resumo usa a última resposta associada. A consulta não modifica respostas
  anteriores nem produz uma trilha completa de alterações do participante.
- A entrega cobre campanhas vinculadas à lista; mensagens transacionais sem
  esse vínculo não aparecem como se fossem campanhas do evento.
- O consumo das respostas não depende de novo sync de Flow. Continua válida a
  restrição operacional de sync durante a coleta registrada no ADR-0008.
- Testes, revisão, deploy e validação real pertencem às issues da entrega;
  este ADR registra a decisão autorizada e não atesta sua conclusão operacional.

## Referências

- [0001](0001-arquitetura-multitenant.md).
- [0002](0002-inclusao-de-listas-manual-csv-api.md).
- [0008](0008-escala-declarada-de-pesquisas-de-flow.md).
- [0009](0009-vinculo-n-n-cliente-integracao.md).
- [0011](0011-identificacao-membros-listas.md).
- [Contrato HTTP](../api-reference.md).
- [Serviço de consulta](../../apps/api/src/api-tokens/public-campaigns.service.ts).

Nenhum ADR anterior foi alterado ou substituído.
