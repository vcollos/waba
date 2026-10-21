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
Sem esse contexto, não há exposição nem associação por proximidade temporal.
A consulta não altera webhook, dados de pessoas ou vínculos armazenados.

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
inferência. Classificação manual auditada exigiria fluxo e autorização próprios;
não foi implementada. Devolver webhook bruto excederia o escopo solicitado.

## Consequências

Consumidores anteriores continuam compatíveis. Textos livres existentes sem
contexto, inclusive respostas plausivelmente relacionadas ao evento, permanecem
indisponíveis nesta API até vínculo explicitamente comprovado. Array vazio não
comprova ausência de mensagens. Não há migration nem novo writer; exige rebuild
e deploy da API para ativar o contrato. O ADR aceito anterior permanece intacto.
