# ADR 0014 — Reenvio de grupo sem resposta por nova execução

- Status: Aceito no escopo do pedido de reenvio confirmado por Vitor.
- Data: 2026-09-24.
- Referências: WABA-58, PEU-351, ADR 0009, ADR 0012, ADR 0013.

## Contexto

O portal agrega campanhas por integração, ID Meta do template e ID Meta do Flow.
O usuário precisa repetir a mensagem para quem recebeu algum envio desse grupo e
ainda não respondeu, sem sobrescrever mensagens, eventos ou respostas anteriores.
O endpoint interno `retryUnansweredFlow` altera mensagens antigas e não atende a
essa trilha histórica.

## Decisão

Adicionar dois POSTs sob `/public/v1/lists/{listId}/campaign-followups`, com o
mesmo token de tenant das consultas públicas. A prévia exige identidade completa
do grupo e devolve totais, exclusões, origem e hash do recorte; não devolve
telefones. A confirmação exige `confirm: true`, o hash atual e
`Idempotency-Key`. O tenant vem exclusivamente do token; lista, vínculo N:N da
integração e campanhas do grupo são validados no servidor.
Para campanhas legadas, o grupo usa a mesma resolução de identidade do endpoint
de listagem: snapshot Meta ou cache válido da mesma integração e botão Flow
aprovado, nunca o nome da campanha. Campanhas em modo `template` que usam botão
Flow também participam do grupo e de suas respostas.

Só entram telefones com evidência de envio em alguma execução do grupo e sem
resposta em nenhuma delas. Resposta de Flow sem `campaignId` também bloqueia
quando integração, ID Meta do Flow e telefone/contato do grupo coincidem;
resposta de outro Flow não bloqueia. O telefone é deduplicado. Qualquer contato
do tenant com opt-out nesse telefone bloqueia o número, mesmo fora da lista.
Antes de enfileirar, o
servidor consulta de novo a lista, estado ativo, opt-out, validade do número,
respostas, template aprovado, botão do mesmo Flow, variáveis e dados atuais dos
contatos. Mudança no recorte invalida o hash e pede nova prévia. A execução nova
usa o mapeamento da execução mais recente com envio comprovado; a prévia
identifica essa origem e sinaliza quando existem mapeamentos diferentes no grupo.

A confirmação reserva uma campanha `draft` com chave de idempotência persistida,
prepara mensagens novas e só então a muda para `queued`. Repetição da chave
recupera a campanha existente. Rascunho interrompido pode ser retomado com a
mesma chave; uma nova chave cancela o rascunho anterior antes de criar outro.
Campanhas concluídas e suas mensagens não são alteradas. O poller existente faz
o envio assíncrono; aceitar a requisição não significa entrega na Meta.
Para esta modalidade, o poller reconsulta membro da lista, contato ativo,
opt-out, template aprovado e respostas do grupo imediatamente antes de cada
chamada à Meta. Se algum critério não valer, marca a nova mensagem como
`skipped` com motivo; a tentativa histórica permanece intacta.

## Alternativas

- Reusar `retryUnansweredFlow`: altera registros antigos e perde a distinção de
  tentativas; rejeitado.
- Selecionar por nome da campanha: não identifica o mesmo template/Flow;
  rejeitado.
- Repetir o payload salvo sem revalidar contato ou template: preservaria dados
  obsoletos e poderia ignorar opt-out; rejeitado.

## Consequências e limites

Os novos campos opcionais da campanha ficam no JSON já persistido, sem migração
de tabela. A idempotência depende da fila serial de escrita do processo único da
API; implantação com múltiplos processos exigirá reserva transacional no banco.
A prévia admite até 20 execuções, 5.000 mensagens e 5.000 respostas no grupo:
consulta contagens limitadas no PostgreSQL antes de carregar registros, lê as
execuções em sequência e busca contatos apenas pelos telefones enviados em
lotes de até 250. A contagem de respostas inclui as não vinculadas à campanha;
índice parcial por integração/Flow apoia essa busca. Grupos acima desses limites pedem fluxo de processamento
dedicado, sem carregar tudo em memória numa requisição HTTP.
Uma resposta que chega entre a última consulta do poller e a chamada à Meta
ainda pode concorrer; não há transação distribuída com a Meta. O portal deve
apresentar a origem e tratar `409` como necessidade de atualizar a prévia.
