import assert from 'node:assert/strict';
import test from 'node:test';
import { ResultsService } from '../apps/api/dist/results/results.service.js';

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
