# 0015 — Respostas textuais com vínculo explícito à campanha

- Status: Aceito no escopo de leitura autorizado por Vitor.
- Data: 2026-10-21.
- Referências: PEU-382; ADR 0009 e ADR 0012.

## Contexto

O Comunicações do evento precisa exibir respostas textuais, inclusive CPFs
solicitados aos acompanhantes. Vitor autorizou explicitamente essa leitura.
A integração é compartilhada entre tenants: o vínculo heurístico registrado
pelo webhook e a exclusividade aparente do histórico por telefone não provam
a qual tenant ou campanha uma mensagem espontânea pertence.

## Decisão

Adicionar `textReplies: [{ messageId, text, receivedAt }]` por destinatário no
contrato público autenticado por token do tenant. A autorização de lista e
campanha precede a consulta. Cada texto exige contexto Meta que aponte para um
ID de envio único, mesmo remetente e mesmo número receptor da integração.
Sem esse contexto, só uma classificação manual explicitamente autorizada e
auditada pode liberar o texto. Em 21/10/2026 Vitor autorizou: "Sim, vincule as
que forem sobre o pedido de CPF", após identificar sete mensagens de três
titulares. O manifesto limita a aplicação às quatro mensagens diretamente
pertinentes, excluindo saudações e agradecimento. Isso não autoriza classificação
de conversas futuras.

O script operacional `scripts/link-campaign-text-replies.mjs` recebe manifesto
fechado de IDs, ator administrador ativo, motivo e referência de autorização.
Dry-run é padrão; `--apply` exige decisão explícita. Uma transação valida
campanha/tenant/lista, envio, remetente, receptor e horário; bloqueia eventos e
recusa reatribuição. Grava somente `record_json.manualCampaignAssociation` e
`audit_logs`, com os mesmos IDs e ator/data/motivo, sem conteúdo/CPF. Payload,
contexto Meta e `campaign_message_id` heurístico permanecem intactos. Repetição
idêntica é no-op; qualquer divergência de vínculo ou auditoria bloqueia.

O reader exige ação, entity/event ID e associação integral idênticos na
auditoria, revalida tenant/lista/campanha/integração/remetente/receptor e devolve
apenas o DTO textual. Não há endpoint novo nem classificador automático.

Esta decisão sucede somente a restrição do ADR 0012 que impediria CPF no novo
campo textual autorizado. A allowlist dos campos Flow permanece igual e os
payloads brutos, tokens e dados técnicos continuam excluídos. Clientes renderizam
texto escapado, sem HTML, extração automática ou envio do conteúdo a telemetria.

Aceitar texto até 4.096 caracteres, sem truncar; rejeitar entradas malformadas.
Deduplicar pelo ID inbound. Acima de 100 respostas por envio, falhar explicitamente
com 503 até existir paginação específica. Textos contam em `responded` e sua
última data em `respondedAt`; presença continua exclusiva do Flow. A política
separada de reenvio para quem não completou Flow permanece inalterada.

## Alternativas

Atribuir por telefone, campanha mais recente ou tenant exclusivo no histórico
foi rejeitado: exclusões, conversas espontâneas e integrações N:N invalidam essa
inferência. A classificação manual auditada foi adotada somente para IDs expressamente
conferidos e autorizados; nenhuma seleção por telefone ou horário a substitui. Devolver webhook bruto excederia o escopo solicitado.

## Consequências

Consumidores anteriores continuam compatíveis. Textos livres existentes sem
contexto permanecem indisponíveis até associação manual auditada explícita. Array vazio não
comprova ausência de mensagens. Não há migration; o writer operacional é restrito e auditado. Exige rebuild
e deploy da API para ativar o contrato. O ADR aceito anterior permanece intacto.
