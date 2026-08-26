#!/usr/bin/env node
/**
 * Verifica se o Direct Send da Meta foi habilitado para uma integração.
 *
 * O Direct Send permite enviar mensagem sem template pré-aprovado. Não há
 * endpoint de elegibilidade na Graph API, então a checagem é feita de duas
 * formas complementares:
 *
 *   1. Sonda: um POST /messages com o campo `category`. Enquanto o recurso
 *      não estiver liberado a Meta responde 400 com error_data.details
 *      dizendo "requires Direct Send, which isn't enabled for this account"
 *      e NADA é enviado. Por isso a sonda usa um número inválido de
 *      propósito (ver DEST_SONDA): a checagem de allowlist acontece antes
 *      da validação do destinatário, então nem em caso de liberação
 *      inesperada uma mensagem real sai daqui.
 *
 *   2. Templates de fallback: a documentação diz que, ao integrar uma WABA
 *      ao Direct Send, a Meta adiciona um conjunto de templates à conta.
 *      O script compara os templates atuais com uma lista conhecida e
 *      aponta os que apareceram sozinhos.
 *
 * Uso:
 *   node scripts/check-direct-send.mjs [integrationId]
 *
 * Sem argumento, verifica todas as integrações ativas.
 * Saída: JSON em stdout. Código de saída 0 = executou; 10 = Direct Send
 * habilitado em alguma integração (para facilitar alerta em cron).
 *
 * O token de acesso é decifrado em memória e nunca é impresso.
 */

import { execFileSync } from 'node:child_process';
import { createDecipheriv, createHash } from 'node:crypto';

const PG_CONTAINER = process.env.WABA_PG_CONTAINER ?? 'waba-postgres-1';
const PG_USER = process.env.POSTGRES_USER ?? 'campaign_sender';
const PG_DB = process.env.POSTGRES_DB ?? 'campaign_sender';

// Número propositalmente inválido: a checagem de allowlist do Direct Send
// acontece ANTES da validação do destinatário, então a sonda nunca entrega
// mensagem a ninguém, mesmo que o recurso seja liberado entre execuções.
const DEST_SONDA = '10000000000';

const psql = (sql) =>
  execFileSync(
    'docker',
    ['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_DB, '-t', '-A', '-F', '\x01', '-c', sql],
    { encoding: 'utf8' },
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split('\x01'));

const decrypt = (ciphertext) => {
  const secret = process.env.APP_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error('APP_ENCRYPTION_KEY não definida no ambiente');
  }
  const key = Buffer.from(createHash('sha256').update(secret).digest('hex'), 'hex');
  const [iv, tag, data] = ciphertext.split('.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'hex')),
    decipher.final(),
  ]).toString('utf8');
};

const probeDirectSend = async (integration) => {
  const { graphApiVersion, phoneNumberId, token } = integration;
  const url = `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: DEST_SONDA,
        type: 'text',
        text: { body: 'probe' },
        category: 'utility',
      }),
    });
  } catch (error) {
    return { estado: 'erro_rede', detalhe: error.message };
  }

  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { estado: 'resposta_ilegivel', http: response.status, detalhe: raw.slice(0, 300) };
  }

  const detalhe = payload?.error?.error_data?.details ?? payload?.error?.message ?? '';

  // A frase de allowlist é o sinal de "ainda não liberado".
  if (/isn't enabled for this account|is not enabled for this account/i.test(detalhe)) {
    return { estado: 'nao_habilitado', http: response.status, detalhe };
  }

  // Erro sobre o destinatário significa que a checagem de allowlist passou:
  // o Direct Send foi liberado e a validação avançou para o próximo estágio.
  if (/recipient|phone number|invalid.*to\b/i.test(detalhe)) {
    return { estado: 'HABILITADO', http: response.status, detalhe };
  }

  if (response.ok) {
    return { estado: 'HABILITADO', http: response.status, detalhe: 'aceito pela Meta' };
  }

  return { estado: 'indeterminado', http: response.status, detalhe: detalhe || raw.slice(0, 300) };
};

const checkFallbackTemplates = (integrationId, lastSyncAt) => {
  const rows = psql(
    `select name from templates where integration_id = '${integrationId}' order by name;`,
  );
  const nomes = rows.map(([name]) => name);
  // Templates criados pela Meta, não pela equipe. `hello_world` é o padrão de
  // toda conta nova e não indica Direct Send.
  const conhecidosDaMeta = new Set(['hello_world']);
  const suspeitos = nomes.filter(
    (nome) => !conhecidosDaMeta.has(nome) && !/^[0-9]{3}_|^campanha_|^confirmacao_|^pesquis/.test(nome),
  );
  // Este sinal só vale se o cache estiver fresco: a lista vem do banco, que só
  // é atualizado no sync manual de templates. Sem sync recente, um template de
  // fallback criado pela Meta não aparece aqui. A sonda acima não tem essa
  // limitação — ela consulta a Meta ao vivo.
  return {
    total: nomes.length,
    naoReconhecidos: suspeitos,
    ultimoSync: lastSyncAt || 'nunca',
    confiavel: Boolean(lastSyncAt),
  };
};

const main = async () => {
  const alvo = process.argv[2];
  const filtro = alvo ? ` and id = '${alvo}'` : '';
  const rows = psql(
    `select id, name, graph_api_version, phone_number_id, access_token_ciphertext,
              coalesce(to_char(last_sync_at, 'YYYY-MM-DD'), '')
       from integrations where status = 'active'${filtro};`,
  );

  if (rows.length === 0) {
    console.log(JSON.stringify({ erro: 'nenhuma integração ativa encontrada', alvo }, null, 2));
    process.exit(1);
  }

  const resultado = [];
  let habilitado = false;

  for (const [id, name, graphApiVersion, phoneNumberId, ciphertext, lastSyncAt] of rows) {
    const token = decrypt(ciphertext);
    const sonda = await probeDirectSend({ graphApiVersion, phoneNumberId, token });
    const templates = checkFallbackTemplates(id, lastSyncAt);
    if (sonda.estado === 'HABILITADO') {
      habilitado = true;
    }
    resultado.push({ integracao: name, id, sonda, templates });
  }

  console.log(
    JSON.stringify({ verificadoEm: new Date().toISOString(), resultado }, null, 2),
  );
  process.exit(habilitado ? 10 : 0);
};

main().catch((error) => {
  console.error(JSON.stringify({ erro: error.message }, null, 2));
  process.exit(1);
});
