import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicCampaignsService, sanitizeCampaignAnswers } from '../apps/api/dist/api-tokens/public-campaigns.service.js';

const campaign = { id: 'campaign', clientId: 'tenant', listId: 'list', integrationId: 'shared', mode: 'template', name: 'Pesquisa', status: 'completed', createdAt: '2026-09-01T10:00:00Z' };
const msg = (id, patch = {}) => ({ id, campaignId: 'campaign', contactId: `contact-${id}`, phoneE164: `+551199999000${id}`, status: 'pending', createdAt: `2026-09-01T10:0${id}:00Z`, ...patch });
const response = (id, patch = {}) => ({ id, campaignId: 'campaign', campaignMessageId: '1', integrationId: 'shared', contactId: 'contact-1', waId: '5511999990001', completedAt: '2026-09-02T10:00:00Z', responsePayload: { presenca: 'Sim', observacao: 'Confirmado' }, ...patch });
function setup({ lists = [{ id: 'list', name: 'Evento' }], campaigns = [campaign], templates = [], flows = [], messages = [], responses = [], contacts = [] } = {}) {
  const calls = [];
  const db = {
    postgresQuery: async (sql, args) => {
      calls.push({ kind: 'sql', sql, args });
      assert.match(sql, /client_id = \$2/); assert.equal(args[1], 'tenant');
      return sql.includes('FROM lists') ? lists : contacts;
    },
    readMetaSnapshot: async () => ({ campaigns, templates, flows }),
    listCampaignMessagesInDatabase: async (query) => { calls.push({ kind: 'messages', query }); assert.deepEqual(query, { campaignId: 'campaign' }); return messages; },
    listFlowResponsesInDatabase: async (query) => { calls.push({ kind: 'responses', query }); assert.deepEqual(query, { campaignId: 'campaign' }); return responses; },
  };
  return { service: new PublicCampaignsService(db), calls };
}
test('tenant estrangeiro: lista é recusada antes de qualquer mensagem/resposta', async () => {
  const { service, calls } = setup({ lists: [] });
  await assert.rejects(service.results('list', 'campaign', 'tenant'), /Lista não encontrada/);
  assert.equal(calls.length, 1);
});
for (const invalid of [{ ...campaign, clientId: 'other' }, { ...campaign, listId: 'other' }, { ...campaign, clientId: null }]) {
  test(`campanha fora do recorte ${JSON.stringify(invalid)} recusada mesmo com zero respostas`, async () => {
    const { service, calls } = setup({ campaigns: [invalid] });
    await assert.rejects(service.results('list', 'campaign', 'tenant'), /Campanha não encontrada/);
    assert.equal(calls.filter((call) => call.kind !== 'sql').length, 0);
  });
}
test('overview inclui campanha sem respostas e sem destinatários', async () => {
  const { service } = setup();
  const result = await service.list('list', 'tenant');
  assert.equal(result.campaigns.length, 1); assert.equal(result.campaigns[0].counters.total, 0);
  assert.deepEqual({ integrationId: result.campaigns[0].integrationId, templateId: result.campaigns[0].templateId,
    templateName: result.campaigns[0].templateName, flowId: result.campaigns[0].flowId, flowName: result.campaigns[0].flowName },
  { integrationId: 'shared', templateId: null, templateName: null, flowId: null, flowName: null });
  assert.equal(result.campaigns[0].flowIdentityStatus, 'none');
});
test('listagem e detalhe expõem IDs Meta estáveis somente dos caches da integração da campanha', async () => {
  const data = {
    campaigns: [{ ...campaign, templateCacheId: 'template-cache', flowCacheId: 'flow-cache' }],
    templates: [
      { id: 'template-cache', integrationId: 'other', metaTemplateId: 'wrong', name: 'Outro tenant' },
      { id: 'template-cache', integrationId: 'shared', metaTemplateId: 'meta-template-1', name: 'Confirmação' },
    ],
    flows: [
      { id: 'flow-cache', integrationId: 'other', metaFlowId: 'wrong', name: 'Outro tenant' },
      { id: 'flow-cache', integrationId: 'shared', metaFlowId: 'meta-flow-1', name: 'Presença' },
    ],
  };
  const { service } = setup(data);
  const expected = { integrationId: 'shared', templateId: 'meta-template-1', templateName: 'Confirmação', flowId: 'meta-flow-1', flowName: 'Presença', flowIdentityStatus: 'resolved' };
  for (const item of [(await service.list('list', 'tenant')).campaigns[0], (await service.results('list', 'campaign', 'tenant')).campaign]) {
    assert.deepEqual(Object.fromEntries(Object.keys(expected).map((key) => [key, item[key]])), expected);
  }
});
test('cache órfão ou de outra integração não vira vínculo por nome', async () => {
  const { service } = setup({
    campaigns: [{ ...campaign, templateCacheId: 'orphan', flowCacheId: 'foreign', name: 'Igual ao modelo' }],
    templates: [{ id: 'another', integrationId: 'shared', metaTemplateId: 'meta-template-1', name: 'Igual ao modelo' }],
    flows: [{ id: 'foreign', integrationId: 'other', metaFlowId: 'meta-flow-1', name: 'Igual ao modelo' }],
  });
  const item = (await service.results('list', 'campaign', 'tenant')).campaign;
  assert.equal(item.templateId, null); assert.equal(item.templateName, null);
  assert.equal(item.flowId, null); assert.equal(item.flowName, null);
  assert.equal(item.flowIdentityStatus, 'unresolved');
});
test('modo Flow sem cache e template com botão de Flow são indeterminados, não ausência de Flow', async () => {
  for (const data of [
    { campaigns: [{ ...campaign, mode: 'template_flow' }] },
    { campaigns: [{ ...campaign, templateCacheId: 'template-cache' }], templates: [{ id: 'template-cache', integrationId: 'shared', metaTemplateId: 'meta-template-1', name: 'Fluxo', hasFlowButton: true }] },
  ]) {
    const { service } = setup(data);
    assert.equal((await service.list('list', 'tenant')).campaigns[0].flowIdentityStatus, 'unresolved');
  }
});
test('todos destinatários reais permanecem mesmo sem contato ou membro atual', async () => {
  const { service, calls } = setup({ messages: [msg('1'), msg('2')] });
  const result = await service.results('list', 'campaign', 'tenant', { limit: 1, offset: 1 });
  assert.equal(result.total, 2); assert.equal(result.items.length, 1); assert.equal(result.items[0].messageId, '2');
  assert.equal(result.items[0].phone, '+5511999990002');
  assert.ok(calls.every((call) => !call.sql?.includes('list_members')));
});
test('evidência readAt não regride com status delivered/pending atrasado; KPI e filtro iguais', async () => {
  const { service } = setup({ messages: [msg('1', { status: 'pending', readAt: '2026-09-02T11:00:00Z' }), msg('2', { status: 'delivered' }), msg('3', { status: 'failed', providerMessageId: 'wamid' })] });
  const result = await service.results('list', 'campaign', 'tenant', { status: 'delivered' });
  assert.equal(result.total, 2); assert.equal(result.items[0].status, 'read');
  assert.deepEqual(result.campaign.counters, { total: 3, accepted: 3, sent: 2, delivered: 2, read: 1, failed: 1, responded: 0, notResponded: 3, presenceYes: 0, presenceNo: 0 });
  assert.equal(result.items[0].deliveredAt, null); // não inventa timestamp
  assert.equal(Object.hasOwn(result.items[0], 'evidence'), false);
});
test('falha após sentAt continua falha, sem perder evidência de envio', async () => {
  const { service } = setup({ messages: [msg('1', { status: 'failed', sentAt: '2026-09-01T11:00:00Z' })] });
  const result = await service.results('list', 'campaign', 'tenant', { status: 'sent' });
  assert.equal(result.total, 1); assert.equal(result.items[0].status, 'failed'); assert.equal(result.campaign.counters.failed, 1);
});
test('última resposta por mensagem vence; nunca expõe payload técnico, CPF ou rawWebhook', async () => {
  const { service } = setup({ messages: [msg('1')], responses: [response('old'), response('latest', { completedAt: '2026-09-03T10:00:00Z', responsePayload: { presenca: 'Não', observacao: 'Viagem', flow_token: 'secret', CPF: '123', payload: { nested: 'secret' }, nps: 9 }, rawWebhook: { secret: true } })] });
  const result = await service.results('list', 'campaign', 'tenant');
  assert.equal(result.items[0].presence, 'no'); assert.equal(result.items[0].observation, 'Viagem');
  assert.deepEqual(result.items[0].answers.map((a) => a.key), ['presenca', 'observacao']);
  assert.ok(!JSON.stringify(result).includes('secret')); assert.equal(result.campaign.counters.responded, 1);
});
test('resposta ligada a outra mensagem não vaza por fallback telefone/contato', async () => {
  const { service } = setup({ messages: [msg('1')], responses: [response('foreign-message', { campaignMessageId: 'not-this-message' })] });
  assert.equal((await service.results('list', 'campaign', 'tenant')).items[0].responded, false);
});
test('resposta sem messageId casa somente com última mensagem do contato', async () => {
  const { service } = setup({ messages: [msg('1'), msg('2', { contactId: 'contact-1', phoneE164: '+5511999990001' })], responses: [response('unlinked', { campaignMessageId: null })] });
  const result = await service.results('list', 'campaign', 'tenant');
  assert.deepEqual(result.items.map((item) => item.responded), [false, true]);
});
test('respostas de outra campanha ou integração são excluídas', async () => {
  const { service } = setup({ messages: [msg('1')], responses: [response('other', { campaignId: 'other' }), response('another', { integrationId: 'other' })] });
  assert.equal((await service.results('list', 'campaign', 'tenant')).campaign.counters.responded, 0);
});
test('resposta sem contactId usa telefone snapshot do envio', async () => {
  const { service } = setup({ messages: [msg('1')], responses: [response('unlinked', { campaignMessageId: null, contactId: null })] });
  assert.equal((await service.results('list', 'campaign', 'tenant')).items[0].responded, true);
});
test('sete campos separados, busca sem acentos e total filtrado sem adulterar KPIs', async () => {
  const { service } = setup({ messages: [msg('1'), msg('2')], responses: [response('r')], contacts: [{ id: 'contact-1', first_name: 'Márcia', last_name: 'Silva', name: 'Márcia Silva', email: 'marcia@example.com', category: 'Titular', attributes_json: { institutionRepresented: 'Uniodonto', jobTitle: 'Presidente' } }] });
  const result = await service.results('list', 'campaign', 'tenant', { search: 'marcia', response: 'yes', presence: 'yes' });
  assert.equal(result.total, 1); assert.equal(result.campaign.counters.total, 2);
  assert.equal(result.items[0].institutionRepresented, 'Uniodonto'); assert.equal(result.items[0].jobTitle, 'Presidente');
});
for (const attributes of [{ institutionRepresented: 'Uniodonto', jobTitle: 'Presidente', cpf: 'private' }, JSON.stringify({ institutionRepresented: 'Uniodonto', jobTitle: 'Presidente', cpf: 'private' })]) {
  test(`atributos de contato ${typeof attributes} preservam campos sem operador JSON SQL`, async () => {
    const { service, calls } = setup({ messages: [msg('1')], contacts: [{ id: 'contact-1', attributes_json: attributes }] });
    const result = await service.results('list', 'campaign', 'tenant');
    assert.equal(result.items[0].institutionRepresented, 'Uniodonto'); assert.equal(result.items[0].jobTitle, 'Presidente');
    assert.ok(calls.filter((call) => call.sql?.includes('FROM contacts')).every((call) => !call.sql.includes('->')));
    assert.ok(!JSON.stringify(result).includes('private')); assert.ok(!JSON.stringify(result).includes('attributes_json'));
  });
}
for (const attributes of [null, '', '{invalid', '[]', 'null', 42]) {
  test(`atributos ausentes ou malformados ${JSON.stringify(attributes)} não quebram a consulta`, async () => {
    const { service } = setup({ messages: [msg('1')], contacts: [{ id: 'contact-1', attributes_json: attributes }] });
    const result = await service.results('list', 'campaign', 'tenant');
    assert.equal(result.items[0].institutionRepresented, null); assert.equal(result.items[0].jobTitle, null);
  });
}
for (const query of [{ limit: 0 }, { limit: 101 }, { limit: NaN }, { offset: -1 }, { offset: 0.5 }, { offset: 1_000_001 }, { status: 'bogus' }, { presence: 'maybe' }, { response: 'bogus' }, { search: 'x'.repeat(201) }]) {
  test(`query inválida ${JSON.stringify(query)} não consulta dados`, async () => {
    const { service, calls } = setup(); await assert.rejects(service.results('list', 'campaign', 'tenant', query), /Filtros/); assert.equal(calls.length, 0);
  });
}
test('sanitização limita respostas e não aceita objetos aninhados nem chaves técnicas', () => {
  const answers = sanitizeCampaignAnswers({ observacao: 'x'.repeat(3000), sessao_id: 'omit', rg: 'omit', nascimento: 'omit', segredoToken: 'omit', providerMessageId: 'omit', obj: {}, atividade: ['a', 'b'], presenca: true });
  assert.equal(answers[0].value.length, 2000); assert.deepEqual(answers.map((a) => a.key), ['observacao', 'atividade', 'presenca']);
});
test('presença nao_comparecerei é negativa, sem substring ambígua', async () => {
  const { service } = setup({ messages: [msg('1')], responses: [response('r', { responsePayload: { presenca: 'nao_comparecerei' } })] });
  const result = await service.results('list', 'campaign', 'tenant', { presence: 'no' });
  assert.equal(result.total, 1); assert.equal(result.campaign.counters.presenceNo, 1);
});
