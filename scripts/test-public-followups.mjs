import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicFollowupsService } from '../apps/api/dist/api-tokens/public-followups.service.js';
import { CampaignsService, approvedTemplateFingerprint } from '../apps/api/dist/campaigns/campaigns.service.js';
import { DispatchService } from '../apps/api/dist/campaigns/dispatch.service.js';

const input = { integrationId: 'integration', templateId: 'template-meta', flowId: 'flow-meta' };
const source = { id: 'campaign-1', clientId: 'tenant', integrationId: 'integration', listId: 'list',
  metaTemplateId: input.templateId, metaFlowId: input.flowId, mode: 'template_flow', name: 'Convite',
  parameterMapping: { 'body:1': { type: 'static', value: 'Evento' } }, status: 'completed',
  createdAt: '2026-09-01T00:00:00Z', sendRateMps: 20 };
const template = { id: 'template-cache', integrationId: 'integration', metaTemplateId: input.templateId,
  status: 'APPROVED', name: 'convite', languageCode: 'pt_BR', lastSyncedAt: '2026-09-01T00:00:00Z',
  components: [{ type: 'BODY', text: 'Convite aprovado atual' }],
  hasFlowButton: true, flowButtonMeta: { flow_id: input.flowId }, variableDescriptors: [] };
const templateFingerprint = approvedTemplateFingerprint(template);
const message = (id, phone, contactId, patch = {}) => ({ id, campaignId: source.id, phoneE164: phone,
  contactId, status: 'sent', payload: { template: { name: 'convite' } }, createdAt: '2026-09-01T00:00:00Z', ...patch });
const contact = (id, phone, patch = {}) => ({ id, first_name: id, name: id, phone_e164: phone, in_list: true,
  phone_hash: 'hash', record_status: 'active', is_opted_out: false, is_valid: true, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', ...patch });

function setup({ list = true, linked = true, campaigns = [source], templates = [template],
  messages = [message('m1', '+5511999990001', 'c1'), message('m2', '+5511999990001', 'c1'),
    message('m3', '+5511999990002', 'c2'), message('m4', '+5511999990003', 'c3')],
  responses = [{ campaignId: source.id, integrationId: 'integration', campaignMessageId: 'm3', contactId: 'c2', waId: '5511999990002' }],
  contacts = [contact('c1', '+5511999990001'), contact('c2', '+5511999990002'), contact('c3', '+5511999990003', { is_opted_out: true })] } = {}) {
  const state = { campaigns: structuredClone(campaigns), templates, flows: [],
    clientIntegrations: linked ? [{ clientId: 'tenant', integrationId: 'integration' }] : [] };
  const saved = [];
  const db = {
    postgresQuery: async (sql, args) => {
      if (sql.includes('FROM lists')) { assert.equal(args[1], 'tenant'); return list ? [{ id: 'list' }] : []; }
      if (sql.includes('AS message_count')) return [{ message_count: String(messages.length), response_count: String(responses.length) }];
      if (sql.includes('AS response_count')) return [{ response_count: '0' }];
      if (sql.includes('fr.record_json->>\'waId\' AS wa_id')) return [];
      if (sql.includes('FROM contacts c') && sql.includes('AS in_list')) {
        assert.equal(args[1], 'tenant'); assert.ok(Array.isArray(args[2]));
        return contacts.filter((item) => args[2].includes(item.phone_e164));
      }
      throw Error(`Unexpected query ${sql}`);
    },
    readMetaSnapshot: async () => state,
    readMeta: async () => state,
    listCampaignMessagesInDatabase: async ({ campaignId }) => messages.filter((m) => m.campaignId === campaignId),
    listFlowResponsesInDatabase: async ({ campaignId }) => responses.filter((r) => r.campaignId === campaignId),
    write: async (mutator) => mutator(state),
    replaceCampaignMessagesForCampaignInDatabase: async (campaignId, items) => { saved.push(...items); },
  };
  const campaignsService = {
    buildTemplatePayload: (campaign, currentTemplate, currentContact, flowToken) => ({
      to: currentContact.phoneE164, template: { name: currentTemplate.name }, flowToken, campaignId: campaign.id,
    }),
    refreshCampaignSummary: async (id) => {
      state.campaigns.find((campaign) => campaign.id === id).summary = { total: saved.length, pending: saved.length };
    },
  };
  const audit = { log: async () => {} };
  return { service: new PublicFollowupsService(db, campaignsService, audit), state, saved, db };
}

test('prévia deduplica telefone, exclui resposta em qualquer tentativa e opt-out', async () => {
  const { service } = setup();
  const preview = await service.preview('list', 'tenant', input);
  assert.deepEqual(preview.counts, { sentPeople: 3, responded: 1, eligible: 1,
    excluded: { responded: 1, notInList: 0, inactive: 0, optedOut: 1, invalidPhone: 0, duplicatePhone: 1 } });
  assert.equal(preview.previewHash.length, 64);
  assert.deepEqual(preview.currentTemplate, { id: input.templateId, name: 'convite', languageCode: 'pt_BR',
    lastSyncedAt: '2026-09-01T00:00:00Z', components: template.components });
  assert.equal(preview.historicalContentVerified, false);
  assert.ok(!JSON.stringify(preview).includes('+5511999990001'));
});

test('sem lista/integração do tenant a consulta para antes de mensagens', async () => {
  for (const options of [{ list: false }, { linked: false }]) {
    const { service } = setup(options);
    await assert.rejects(service.preview('list', 'tenant', input), /não encontrada/);
  }
});

test('confirmação exige hash atual, chave e confirma, e cria execução separada idempotente', async () => {
  const { service, state, saved } = setup();
  const preview = await service.preview('list', 'tenant', input);
  await assert.rejects(service.execute('list', 'tenant', { ...input, previewHash: preview.previewHash }, 'followup-001', 'actor'), /Confirmação/);
  await assert.rejects(service.execute('list', 'tenant', { ...input, previewHash: '0'.repeat(64), confirm: true }, 'followup-001', 'actor'), /audiência mudou/);
  const result = await service.execute('list', 'tenant', { ...input, previewHash: preview.previewHash, confirm: true }, 'followup-001', 'actor');
  assert.equal(result.status, 'queued'); assert.equal(result.recipientCount, 1); assert.equal(result.replayed, false);
  assert.equal(state.campaigns.length, 2); assert.equal(source.status, 'completed');
  assert.equal(state.campaigns[1].followupTemplateFingerprint, templateFingerprint);
  assert.equal(saved.length, 1); assert.notEqual(saved[0].campaignId, source.id); assert.equal(saved[0].phoneE164, '+5511999990001');
  const replay = await service.execute('list', 'tenant', { ...input, previewHash: preview.previewHash, confirm: true }, 'followup-001', 'actor');
  assert.equal(replay.campaignId, result.campaignId); assert.equal(replay.replayed, true); assert.equal(saved.length, 1);
});

test('template reprovado ou Flow divergente bloqueia a prévia', async () => {
  for (const patch of [{ status: 'REJECTED' }, { flowButtonMeta: { flow_id: 'other' } }]) {
    const { service } = setup({ templates: [{ ...template, ...patch }] });
    await assert.rejects(service.preview('list', 'tenant', input), /Template aprovado/);
  }
});

test('mapeamentos diferentes escolhem última execução com envio e sinalizam variante', async () => {
  const older = { ...source, id: 'campaign-older', createdAt: '2026-08-01T00:00:00Z',
    parameterMapping: { 'body:1': { type: 'static', value: 'Outro' } } };
  const { service } = setup({ campaigns: [older, source],
    messages: [message('old', '+5511999990004', 'c4', { campaignId: older.id }),
      message('current', '+5511999990001', 'c1')], responses: [],
    contacts: [contact('c4', '+5511999990004'), contact('c1', '+5511999990001')] });
  const preview = await service.preview('list', 'tenant', input);
  assert.equal(preview.group.sourceCampaignId, source.id);
  assert.equal(preview.group.mappingVariants, true);
  assert.equal(preview.counts.eligible, 2);
});

test('falha após reserva deixa rascunho recuperável sem criar segundo envio', async () => {
  const { service, state, saved, db } = setup();
  const preview = await service.preview('list', 'tenant', input);
  const save = db.replaceCampaignMessagesForCampaignInDatabase;
  let fail = true;
  db.replaceCampaignMessagesForCampaignInDatabase = async (...args) => {
    if (fail) { fail = false; throw Error('storage unavailable'); }
    return save(...args);
  };
  const body = { ...input, previewHash: preview.previewHash, confirm: true };
  await assert.rejects(service.execute('list', 'tenant', body, 'followup-001', 'actor'), /storage unavailable/);
  assert.equal(state.campaigns[1].status, 'draft'); assert.equal(saved.length, 0);
  const resumed = await service.execute('list', 'tenant', body, 'followup-001', 'actor');
  assert.equal(resumed.status, 'queued'); assert.equal(resumed.replayed, true);
  assert.equal(state.campaigns.length, 2); assert.equal(saved.length, 1);
});

test('rascunho órfão com audiência alterada é cancelado e não bloqueia nova prévia', async () => {
  const { service, state, db } = setup();
  const first = await service.preview('list', 'tenant', input);
  db.replaceCampaignMessagesForCampaignInDatabase = async () => { throw Error('storage unavailable'); };
  await assert.rejects(service.execute('list', 'tenant', { ...input, previewHash: first.previewHash, confirm: true }, 'followup-001', 'actor'), /storage unavailable/);
  const old = state.campaigns[1];
  db.listFlowResponsesInDatabase = async () => [{ campaignId: source.id, integrationId: 'integration',
    campaignMessageId: 'm1', contactId: 'c1', waId: '5511999990001' }];
  const second = await service.preview('list', 'tenant', input);
  assert.notEqual(second.previewHash, first.previewHash);
  await assert.rejects(service.execute('list', 'tenant', { ...input, previewHash: first.previewHash, confirm: true }, 'followup-001', 'actor'), /rascunho foi cancelado/);
  assert.equal(old.status, 'cancelled');
});

test('novo idempotency key substitui rascunho órfão mesmo com mesma prévia', async () => {
  const { service, state, db } = setup();
  const preview = await service.preview('list', 'tenant', input);
  const save = db.replaceCampaignMessagesForCampaignInDatabase;
  db.replaceCampaignMessagesForCampaignInDatabase = async () => { throw Error('storage unavailable'); };
  const body = { ...input, previewHash: preview.previewHash, confirm: true };
  await assert.rejects(service.execute('list', 'tenant', body, 'followup-001', 'actor'), /storage unavailable/);
  const old = state.campaigns[1];
  db.replaceCampaignMessagesForCampaignInDatabase = save;
  const created = await service.execute('list', 'tenant', body, 'followup-002', 'actor');
  assert.equal(old.status, 'cancelled'); assert.equal(created.status, 'queued');
  assert.notEqual(created.campaignId, old.id); assert.equal(state.campaigns.length, 3);
});

test('mudança do template aprovado ou do contato invalida a confirmação', async () => {
  const data = setup();
  const preview = await data.service.preview('list', 'tenant', input);
  template.languageCode = 'pt_PT';
  await assert.rejects(data.service.execute('list', 'tenant', { ...input, previewHash: preview.previewHash, confirm: true },
    'followup-003', 'actor'), /audiência mudou/);
  template.languageCode = 'pt_BR';
  const currentContacts = [contact('c1', '+5511999990001'), contact('c2', '+5511999990002'),
    contact('c3', '+5511999990003', { is_opted_out: true })];
  const changed = setup({ contacts: currentContacts });
  const baseline = await changed.service.preview('list', 'tenant', input);
  currentContacts[0].name = 'Nome atualizado';
  await assert.rejects(changed.service.execute('list', 'tenant', { ...input, previewHash: baseline.previewHash, confirm: true },
    'followup-004', 'actor'), /audiência mudou/);
});

test('alteração do texto aprovado atual invalida a prévia mesmo com mesmo nome e ID Meta', async () => {
  const current = { ...template, components: structuredClone(template.components) };
  const data = setup({ templates: [current] });
  const preview = await data.service.preview('list', 'tenant', input);
  current.components[0].text = 'Convite aprovado editado';
  await assert.rejects(data.service.execute('list', 'tenant', { ...input, previewHash: preview.previewHash,
    confirm: true }, 'followup-005', 'actor'), /audiência mudou/);
});

test('poller pula resposta/opt-out novo antes de chamar a Meta', async () => {
  const campaign = { ...source, id: 'followup', status: 'queued', followupSourceCampaignId: source.id,
    followupTemplateFingerprint: templateFingerprint };
  const pending = message('new', '+5511999990001', 'c1', { campaignId: campaign.id, status: 'pending' });
  const saved = [];
  let sent = 0;
  const db = {
    readMetaSnapshot: async () => ({ campaigns: [campaign] }),
    saveCampaignMessageInDatabase: async (item) => { saved.push(item); },
  };
  const service = new DispatchService(db, {}, { sendMessage: async () => { sent++; } },
    { followupSkipReason: async () => 'followup_already_responded' });
  await service.sendMessage(pending, { id: 'integration' }, campaign);
  assert.equal(sent, 0); assert.equal(saved[0].status, 'skipped');
  assert.equal(saved[0].skipReason, 'followup_already_responded');
});

test('consulta final do poller exige membro ativo e examina resposta por telefone', async () => {
  const campaign = { ...source, id: 'followup', status: 'queued', followupSourceCampaignId: source.id,
    followupTemplateFingerprint: templateFingerprint };
  const pending = message('new', '+5511999990001', 'c1', { campaignId: campaign.id, status: 'pending' });
  const db = {
    readMetaSnapshot: async () => ({ campaigns: [source, campaign], templates: [template], flows: [] }),
    postgresQuery: async (sql, args) => {
      if (sql.includes('AS opted_out')) {
        assert.deepEqual(args, ['list', 'tenant', 'c1', '5511999990001']);
        return [{ opted_out: false, eligible: true }];
      }
      assert.match(sql, /flow_responses/);
      assert.deepEqual(args, ['integration', [source.id], 'c1', '5511999990001', 'flow-meta']);
      return [{ id: 'response-late' }];
    },
  };
  const service = new CampaignsService(db, {}, {});
  assert.equal(await service.followupSkipReason(campaign, pending), 'followup_already_responded');
});

test('opt-out entre fila e Meta impede o envio do follow-up', async () => {
  const campaign = { ...source, id: 'followup', status: 'queued', followupSourceCampaignId: source.id,
    followupTemplateFingerprint: templateFingerprint };
  const pending = message('new', '+5511999990001', 'c1', { campaignId: campaign.id, status: 'pending' });
  const db = {
    readMetaSnapshot: async () => ({ campaigns: [source, campaign], templates: [template], flows: [] }),
    postgresQuery: async (sql) => sql.includes('AS opted_out') ? [{ opted_out: true, eligible: true }] : [],
  };
  const service = new CampaignsService(db, {}, {});
  assert.equal(await service.followupSkipReason(campaign, pending), 'followup_phone_opted_out');
});

test('alteração do conteúdo do template após a fila pula mensagem antes da Meta', async () => {
  const campaign = { ...source, id: 'followup', status: 'queued', followupSourceCampaignId: source.id,
    followupTemplateFingerprint: templateFingerprint };
  const pending = message('new', '+5511999990001', 'c1', { campaignId: campaign.id, status: 'pending' });
  const changed = { ...template, components: [{ type: 'BODY', text: 'Outro texto aprovado' }] };
  const saved = [];
  let sent = 0;
  const db = {
    readMetaSnapshot: async () => ({ campaigns: [source, campaign], templates: [changed], flows: [] }),
    saveCampaignMessageInDatabase: async (item) => { saved.push(item); },
    postgresQuery: async () => { throw Error('Não deve consultar destinatários quando o template mudou'); },
  };
  const guard = new CampaignsService(db, {}, {});
  const dispatcher = new DispatchService(db, {}, { sendMessage: async () => { sent++; } }, guard);
  await dispatcher.sendMessage(pending, { id: 'integration' }, campaign);
  assert.equal(sent, 0);
  assert.equal(saved[0].status, 'skipped');
  assert.equal(saved[0].skipReason, 'followup_template_changed');
});

test('prévia inclui execução legada resolvida pelo cache e sua resposta', async () => {
  const legacy = { ...source, id: 'legacy', createdAt: '2026-08-01T00:00:00Z',
    metaTemplateId: undefined, metaFlowId: undefined, templateCacheId: template.id, flowCacheId: null };
  const { service } = setup({ campaigns: [legacy, source], templates: [template],
    messages: [message('legacy-msg', '+5511999990001', 'c1', { campaignId: legacy.id }),
      message('recent-msg', '+5511999990002', 'c2', { campaignId: source.id })],
    responses: [{ campaignId: legacy.id, integrationId: 'integration', campaignMessageId: 'legacy-msg',
      contactId: 'c1', waId: '5511999990001' }],
    contacts: [contact('c1', '+5511999990001'), contact('c2', '+5511999990002')] });
  const preview = await service.preview('list', 'tenant', input);
  assert.deepEqual(preview.campaignIds, ['campaign-1', 'legacy']);
  assert.equal(preview.counts.sentPeople, 2);
  assert.equal(preview.counts.responded, 1);
  assert.equal(preview.counts.eligible, 1);
});

test('guard final consulta resposta da execução legada resolvida pelo cache', async () => {
  const legacy = { ...source, id: 'legacy', metaTemplateId: undefined, metaFlowId: undefined,
    templateCacheId: template.id, flowCacheId: null };
  const followup = { ...source, id: 'followup', status: 'queued', followupSourceCampaignId: legacy.id,
    followupTemplateFingerprint: templateFingerprint };
  const pending = message('new', '+5511999990001', 'c1', { campaignId: followup.id, status: 'pending' });
  const db = {
    readMetaSnapshot: async () => ({ campaigns: [legacy, followup], templates: [template], flows: [] }),
    postgresQuery: async (sql, args) => {
      if (sql.includes('AS opted_out')) return [{ opted_out: false, eligible: true }];
      assert.deepEqual(args[1], ['legacy']);
      return [{ id: 'legacy-response' }];
    },
  };
  const service = new CampaignsService(db, {}, {});
  assert.equal(await service.followupSkipReason(followup, pending), 'followup_already_responded');
});

test('modo template com botão Flow participa do grupo e bloqueia quem respondeu', async () => {
  const templateMode = { ...source, id: 'template-mode', mode: 'template',
    metaTemplateId: undefined, metaFlowId: undefined, templateCacheId: template.id, flowCacheId: null };
  const { service } = setup({ campaigns: [templateMode, source],
    messages: [message('template-msg', '+5511999990001', 'c1', { campaignId: templateMode.id }),
      message('source-msg', '+5511999990002', 'c2', { campaignId: source.id })],
    responses: [{ campaignId: templateMode.id, integrationId: 'integration', campaignMessageId: 'template-msg',
      contactId: 'c1', waId: '5511999990001' }],
    contacts: [contact('c1', '+5511999990001'), contact('c2', '+5511999990002')] });
  const preview = await service.preview('list', 'tenant', input);
  assert.deepEqual(preview.campaignIds, ['campaign-1', 'template-mode']);
  assert.equal(preview.counts.responded, 1); assert.equal(preview.counts.eligible, 1);
});

test('limite SQL barra grupos enormes antes de carregar mensagens ou respostas', async () => {
  for (const volume of [{ message_count: '5001', response_count: '0' },
    { message_count: '10', response_count: '5001' }]) {
    const { service, db } = setup();
    const query = db.postgresQuery;
    let loaded = 0;
    db.postgresQuery = async (sql, args) => sql.includes('AS message_count') ? [volume] : query(sql, args);
    db.listCampaignMessagesInDatabase = async () => { loaded++; return []; };
    db.listFlowResponsesInDatabase = async () => { loaded++; return []; };
    await assert.rejects(service.preview('list', 'tenant', input), /acima do limite/);
    assert.equal(loaded, 0);
  }
});

test('opt-out de outro contato do tenant bloqueia telefone mesmo fora da lista', async () => {
  const outside = contact('duplicate-optout', '+5511999990001', { in_list: false, is_opted_out: true });
  const { service } = setup({ contacts: [contact('c1', '+5511999990001'), outside,
    contact('c2', '+5511999990002'), contact('c3', '+5511999990003', { is_opted_out: true })] });
  const preview = await service.preview('list', 'tenant', input);
  assert.equal(preview.counts.eligible, 0);
  assert.equal(preview.counts.excluded.optedOut, 2);
});

test('guard final detecta opt-out tardio no segundo contato em formato alternativo', async () => {
  const campaign = { ...source, id: 'followup', status: 'queued', followupSourceCampaignId: source.id,
    followupTemplateFingerprint: templateFingerprint };
  const pending = message('new', '+5511999990001', 'c1', { campaignId: campaign.id, status: 'pending' });
  const db = {
    readMetaSnapshot: async () => ({ campaigns: [source, campaign], templates: [template], flows: [] }),
    postgresQuery: async (sql, args) => {
      if (sql.includes('AS opted_out')) {
        assert.match(sql, /c.phone_e164 IN \(\$4, '\+' \|\| \$4\)/);
        assert.equal(args[3], '5511999990001');
        // O contato que fez opt-out pode armazenar o número sem +.
        return [{ opted_out: true, eligible: true }];
      }
      return [];
    },
  };
  assert.equal(await new CampaignsService(db, {}, {}).followupSkipReason(campaign, pending), 'followup_phone_opted_out');
});

test('resposta sem campaignId do mesmo Flow e waId exclui telefone na prévia', async () => {
  const { service, db } = setup({ messages: [message('m1', '+5511999990001', 'c1')], responses: [],
    contacts: [contact('c1', '+5511999990001')] });
  const query = db.postgresQuery;
  db.postgresQuery = async (sql, args) => {
    if (sql.includes('AS response_count') && sql.includes('fr.campaign_id IS NULL')) {
      assert.equal(args[0], 'integration'); assert.equal(args[1], 'flow-meta');
      assert.deepEqual(args[2], ['5511999990001']);
      return [{ response_count: '1' }];
    }
    if (sql.includes('fr.record_json->>\'waId\' AS wa_id')) {
      return [{ id: 'unlinked', campaign_message_id: null, contact_id: null, wa_id: '55 (11) 99999-0001' }];
    }
    return query(sql, args);
  };
  const preview = await service.preview('list', 'tenant', input);
  assert.equal(preview.counts.responded, 1); assert.equal(preview.counts.eligible, 0);
});

test('respostas sem campanha entram no limite total antes de carregar payload', async () => {
  const { service, db } = setup();
  const query = db.postgresQuery;
  let loadedUnlinked = false;
  db.postgresQuery = async (sql, args) => {
    if (sql.includes('AS response_count') && sql.includes('fr.campaign_id IS NULL')) return [{ response_count: '5000' }];
    if (sql.includes('fr.record_json->>\'waId\' AS wa_id')) { loadedUnlinked = true; return []; }
    return query(sql, args);
  };
  await assert.rejects(service.preview('list', 'tenant', input), /acima do limite/);
  assert.equal(loadedUnlinked, false);
});

test('guard final reconhece resposta sem campanha somente no mesmo Flow', async () => {
  const campaign = { ...source, id: 'followup', status: 'queued', followupSourceCampaignId: source.id,
    followupTemplateFingerprint: templateFingerprint };
  const pending = message('new', '+5511999990001', 'c1', { campaignId: campaign.id, status: 'pending' });
  const db = {
    readMetaSnapshot: async () => ({ campaigns: [source, campaign], templates: [template], flows: [] }),
    postgresQuery: async (sql, args) => {
      if (sql.includes('AS opted_out')) return [{ opted_out: false, eligible: true }];
      assert.match(sql, /fr.campaign_id IS NULL AND fr.meta_flow_id = \$5/);
      assert.equal(args[4], 'flow-meta');
      return [{ id: 'unlinked-response' }];
    },
  };
  assert.equal(await new CampaignsService(db, {}, {}).followupSkipReason(campaign, pending), 'followup_already_responded');
});
