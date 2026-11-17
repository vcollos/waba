import assert from 'node:assert/strict';
import test from 'node:test';
import { ResultsService } from '../apps/api/dist/results/results.service.js';
import { SurveyReportsService, consolidateSurvey } from '../apps/api/dist/reports/survey-reports.service.js';
import { ReportsController } from '../apps/api/dist/reports/reports.controller.js';
import { RolesGuard } from '../apps/api/dist/common/roles.guard.js';
import { Reflector } from '@nestjs/core';

const options = ['Muito insatisfeito', 'Insatisfeito', 'Neutro', 'Satisfeito', 'Muito satisfeito']
  .map((title, index) => ({ id: String(index + 1), title }));
async function summary(values, declared = [...options, { id: 'na', title: 'Não participei' }]) {
  const flow = { id: 'flow', metaFlowId: 'meta', name: 'Pesquisa',
    inputFieldDefinitions: [{ screenId: 'START', name: 'rating', type: 'Dropdown', options: declared }],
    screenTransitions: [{ screenId: 'START', nextScreenId: 'END', payloadFields: [{ key: 'rating', sourceType: 'form', sourceField: 'rating' }] }],
    completionPayloadDefinitions: [{ screenId: 'END', actionName: 'complete', payloadFields: [{ key: 'csat_palestra', sourceType: 'expression', sourceField: 'rating', expression: '${data.rating}' }] }] };
  const responses = values.map((value) => ({ campaignId: 'own', metaFlowId: 'meta', flowCacheId: 'old-cache', completedAt: '2026-10-23T12:00:00Z', responsePayload: { csat_palestra: value } }));
  const db = {
    readMetaSnapshot: async () => ({ campaigns: [{ id: 'own', clientId: 'tenant', name: 'Pesquisa', summary: { total: 0 } }, { id: 'foreign', clientId: 'other' }], flows: [flow], templates: [] }),
    listFlowResponsesInDatabase: async () => [...responses, { ...responses[0], campaignId: 'foreign', responsePayload: { csat_palestra: '5' } }],
    listCampaignMessagesInDatabase: async () => [], listMessageEventsInDatabase: async () => [],
  };
  return new ResultsService(db).summary('tenant');
}
for (const title of ['Não participei', 'Não se aplica / Não participei']) {
  test(`CSAT declarado sem nota 5 e com ${title}, isolado por tenant e com cache órfão`, async () => {
    const result = await summary(['3', '4', 'na'], [...options, { id: 'na', title }]);
    const [metric] = result.surveyMetrics;
    assert.equal(result.totalFlowResponses, 3);
    assert.equal(metric.scaleSource, 'declared');
    assert.equal(metric.scaleOrientation, 'ascending');
    assert.equal(metric.score, 50);
    assert.equal(metric.validResponses, 2);
    assert.equal(metric.ignoredResponses, 1);
    assert.deepEqual(metric.distribution.map((d) => d.value), ['1', '2', '3', '4', '5']);
  });
}
test('não participação sozinha não gera score nem nota zero', async () => {
  assert.deepEqual((await summary(['na', 'na'])).surveyMetrics, []);
});
test('escala invertida mantém zero legítimo e exclui na', async () => {
  const inverted = [...options].reverse().map((o, i) => ({ ...o, id: String(i) }));
  const [metric] = (await summary(['0', '3', 'na'], [...inverted, { id: 'na', title: 'Não participei' }])).surveyMetrics;
  assert.equal(metric.scaleOrientation, 'descending'); assert.equal(metric.score, 50);
  assert.equal(metric.validResponses, 2); assert.equal(metric.ignoredResponses, 1);
});
for (const extra of [{ id: 'other', title: 'Não participei' }, { id: 'na', title: 'Outra opção' }]) {
  test(`opção textual desconhecida preserva fallback: ${extra.id}/${extra.title}`, async () => {
    const [metric] = (await summary(['3', '4'], [...options, extra])).surveyMetrics;
    assert.equal(metric.scaleSource, 'observed');
  });
}

const research = { id: 'original', clientId: 'tenant', integrationId: 'integration', metaFlowId: 'flow-meta', name: 'Pesquisa Campinas', createdAt: '2026-10-28T12:00:00Z' };
const retry = { ...research, id: 'retry', name: 'Reenvio Campinas', createdAt: '2026-11-13T12:00:00Z' };
const surveyMessage = (id, campaignId, phone, patch = {}) => ({ id, campaign_id: campaignId, contact_id: `contact-${phone}`, phone, sent: true, delivered: true, failed: false, ...patch });
const answer = (campaignId, phone, patch = {}) => ({ campaign_id: campaignId, campaign_message_id: null, contact_id: `contact-${phone}`, phone, completed_at: '2026-11-17T12:00:00Z', ...patch });

test('consolidado conta pessoas únicas entre original/reenvio, com respostas repetidas e contatos duplicados', () => {
  const report = consolidateSurvey([research, retry], [
    surveyMessage('m1', 'original', '5511111111111'),
    surveyMessage('m2', 'original', '5522222222222'),
    surveyMessage('m3', 'retry', '5522222222222', { contact_id: 'duplicate' }),
    surveyMessage('m4', 'retry', '5533333333333', { sent: false, delivered: false, failed: true }),
  ], [answer('original', '5511111111111'), answer('original', '5511111111111'), answer('retry', '5522222222222', { contact_id: 'duplicate' })]);
  assert.equal(report.totals.audience, 3); assert.equal(report.totals.contacted, 2);
  assert.equal(report.totals.responded, 2); assert.equal(report.totals.unanswered, 0);
  assert.equal(report.totals.responseRate, 100); assert.equal(report.totals.failedMessages, 1);
  assert.deepEqual(report.executions.map((row) => row.responded), [1, 1]);
});

test('resposta comprova contato mesmo com status atrasado; desconhecidos e contato ambíguo não aumentam indicador', () => {
  const report = consolidateSurvey([research], [
    surveyMessage('m1', 'original', '5511111111111', { contact_id: 'shared', sent: false, delivered: false }),
    surveyMessage('m2', 'original', '5522222222222', { contact_id: 'shared', sent: false, delivered: false }),
  ], [answer('original', '', { campaign_message_id: 'm1', contact_id: 'shared' }),
    answer('original', '', { contact_id: 'shared' }), answer('original', '5599999999999')]);
  assert.equal(report.totals.responded, 1); assert.equal(report.totals.contacted, 1);
  assert.equal(report.unmatchedResponses, 2);
});

test('mesma pessoa responde em dois envios: consolidado 1, detalhe 1 em cada envio; público vazio tem taxa zero', () => {
  const report = consolidateSurvey([research, retry], [surveyMessage('m1', 'original', '55'), surveyMessage('m2', 'retry', '55')], [answer('original', '55'), answer('retry', '55')]);
  assert.equal(report.totals.responded, 1); assert.deepEqual(report.executions.map((row) => row.responded), [1, 1]);
  assert.equal(consolidateSurvey([research], [], []).totals.responseRate, 0);
});

function surveyDb() {
  const calls = [];
  const campaigns = [research, retry, { ...research, id: 'foreign', clientId: 'other' },
    { ...research, id: 'other-account', integrationId: 'other' }, { ...research, id: 'other-flow', metaFlowId: 'different-flow' },
    { ...research, id: 'legacy', metaFlowId: null, templateCacheId: 'template' },
    { ...research, id: 'svc:integration' }, { ...research, id: 'unresolved', metaFlowId: null }];
  return { calls, service: new SurveyReportsService({
    readMetaSnapshot: async () => ({ campaigns, clients: [{ id: 'tenant', name: 'Campinas' }], flows: [],
      templates: [{ id: 'template', integrationId: 'integration', hasFlowButton: true, flowButtonMeta: { flow_id: 2080625443327961 } }] }),
    postgresQuery: async (sql, parameters) => {
      calls.push({ sql, parameters });
      assert.deepEqual(new Set(parameters[0]), new Set(['original', 'retry']));
      assert.doesNotMatch(sql, /SELECT \*|responsePayload|rawWebhook/);
      if (sql.includes('FROM campaign_messages')) return [surveyMessage('m1', 'original', '55'), surveyMessage('m2', 'retry', '55')];
      assert.equal(parameters[1], 'integration');
      return [answer('original', '55'), answer('retry', '55')];
    },
  }) };
}

test('catálogo separa tenant/integração/Flow e resolve ID numérico legado sem sync', async () => {
  const { service, calls } = surveyDb();
  const groups = await service.list('tenant');
  assert.equal(groups.length, 4); assert.equal(groups.find((group) => group.flowId === 'flow-meta' && group.integrationId === 'integration').executions, 2);
  assert.ok(groups.some((group) => group.flowId === '2080625443327961'));
  assert.ok(!groups.some((group) => group.clientId === 'other')); assert.equal(calls.length, 0);
  assert.deepEqual(await service.list('__none__'), []);
});

test('campanha estrangeira ou inexistente não consulta mensagens/respostas; detalhe e CSV preservam deduplicação', async () => {
  const { service, calls } = surveyDb();
  await assert.rejects(service.report('foreign', 'tenant'), /Pesquisa não encontrada/);
  await assert.rejects(service.report('missing', null), /Pesquisa não encontrada/);
  assert.equal(calls.length, 0);
  const report = await service.report('retry', 'tenant'); assert.equal(report.totals.responded, 1);
  assert.equal(report.totals.messages, 2);
  const csv = await service.csv('original', 'tenant');
  assert.match(csv, /CONSOLIDADO/); assert.match(csv, /Pessoas que responderam/);
  assert.equal(csv.trim().split('\n').length, 4);
});

test('rotas de pesquisa mantêm papéis administrativos e client_admin não altera o tenant pela query', async () => {
  const { service, calls } = surveyDb();
  const controller = new ReportsController(undefined, service);
  const guard = new RolesGuard(new Reflector());
  for (const method of ['surveyList', 'surveyReport', 'surveyCsv']) {
    for (const role of ['viewer', 'operator']) {
      assert.throws(() => guard.canActivate({ getHandler: () => controller[method], getClass: () => ReportsController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }) }), /Acesso restrito/);
    }
  }
  await assert.rejects(controller.surveyReport('foreign', { user: { role: 'client_admin', clientIds: ['tenant'] } }, 'other'), /Pesquisa não encontrada/);
  assert.equal(calls.length, 0);
});
