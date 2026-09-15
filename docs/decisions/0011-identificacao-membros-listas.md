# 0011 — Identificação dos membros de listas

- Status: Aceito no escopo solicitado explicitamente por Vitor.
- Data: 2026-09-15.
- Referência: WABA-31 e integração PEU-263.

## Contexto

Vitor pediu os campos Nome, Sobrenome, Uniodonto, Cargo/Função, WhatsApp,
E-mail e Categoria na própria lista WABA, na ordem acima, além da prévia no portal.

## Decisão

Reutilizar first_name/last_name, telefone, email e categoria existentes. Armazenar
Uniodonto e Cargo/Função em attributes_json, nas chaves institutionRepresented e
jobTitle. A API pública aceita as duas propriedades explícitas opcionais de até
200 caracteres. Preservar atributos não enviados, isolamento pelo tenant do token
e opt-out. Não inferir tenant pela instituição representada.

A tabela e os formulários de membros expõem esses dados. O portal envia as duas
propriedades somente quando preenchidas. Contatos antigos recebem esses valores
na próxima sincronização; a mudança de código não altera contatos automaticamente.

## Alternativas

Colunas SQL novas exigiriam migração sem necessidade: o contato já tem atributos
para dados complementares. Usar client_id ou categoria para instituição/cargo
misturaria autorização e segmentação com identificação.

## Consequências

Nenhuma migração destrutiva ou recriação de lista. Nome completo segue derivado
para compatibilidade. Dados anteriores e campanhas permanecem. Somente uma
sincronização explicitamente acionada transporta os novos valores ao WABA.

## Referências

- [0001](0001-arquitetura-multitenant.md)
- [0002](0002-inclusao-de-listas-manual-csv-api.md)
- [0003](0003-telefone-unico-por-tenant.md)
