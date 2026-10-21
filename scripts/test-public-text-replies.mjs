import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { PublicCampaignsService } from '../apps/api/dist/api-tokens/public-campaigns.service.js';

// Only a disposable local PostgreSQL: fixtures are session-local TEMP tables.
const url = process.env.WABA_TEST_DATABASE_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('Use PostgreSQL local isolado');
test('respostas textuais: SQL real isola contexto, remetente, integração e campanha', { skip: !url }, async () => {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    await db.query(`CREATE TEMP TABLE campaign_messages (id text, campaign_id text, provider_message_id text, record_json jsonb);
      CREATE TEMP TABLE message_events (provider_message_id text,event_type text,received_at timestamptz,record_json jsonb)`);
    const campaign = { id: 'campaign', listId: 'list', clientId: 'tenant', integrationId: 'shared', mode: 'template', createdAt: '2026-10-21T10:00:00Z' };
    const message = { id: 'message', campaignId: campaign.id, contactId: 'contact', phoneE164: '+5511999999999', providerMessageId: 'outgoing', status: 'sent', createdAt: campaign.createdAt };
    await db.query('INSERT INTO campaign_messages VALUES ($1,$2,$3,$4)', [message.id, campaign.id, message.providerMessageId, message]);
    const service = new PublicCampaignsService({
      readMetaSnapshot: async () => ({ campaigns: [campaign], templates: [], flows: [], integrations: [{ id: 'shared', phoneNumberId: 'receiving' }] }),
      listCampaignMessagesInDatabase: async () => [message], listFlowResponsesInDatabase: async () => [],
      postgresQuery: async (sql, args) => sql.includes('FROM message_events') ? (await db.query(sql,args)).rows : sql.includes('FROM lists') ? [{ id: 'list' }] : [],
    });
    let serial = 0;
    const add = async (patch = {}, phone = 'receiving', eventPatch = {}) => {
      const inbound = { id: `in-${++serial}`, type: 'text', from: '5511999999999', context: { id: 'outgoing' }, text: { body: '<script>alert("CPF sintético")</script> 00000000000' }, ...patch };
      const payload = { entry: [{ changes: [{ value: { metadata: { phone_number_id: phone }, messages: [inbound] } }] }] };
      await db.query('INSERT INTO message_events VALUES ($1,$2,$3,$4)', [eventPatch.id ?? inbound.id, eventPatch.type ?? 'meta.inbound', '2026-10-21T11:00:00Z', { payload }]);
      return inbound.id;
    };
    const id = await add();
    await add({ id }); // repeated webhook
    await add({ from: '5511888888888' });
    await add({}, 'other-integration');
    await add({ context: undefined });
    await add({ context: { id: 'other-provider' } });
    await add({ type: 'image' });
    await add({ text: { body: { secret: 'not-a-string' } } });
    await add({}, 'receiving', { id: 'different-event-id' });
    await add({}, 'receiving', { type: 'meta.flow_reply' });
    await add({ text: { body: 'x'.repeat(4097) } });
    await db.query('INSERT INTO campaign_messages VALUES ($1,$2,$3,$4)', ['foreign', 'foreign-tenant-campaign', 'other-provider', message]);
    let result = await service.results('list','campaign','tenant');
    assert.equal(result.items[0].textReplies.length, 1);
    assert.deepEqual(Object.keys(result.items[0].textReplies[0]).sort(), ['messageId','receivedAt','text']);
    assert.equal(result.items[0].textReplies[0].messageId, id);
    assert.match(result.items[0].textReplies[0].text, /^<script>/); // inert JSON string; consumer must escape
    assert.equal(result.items[0].responded, true);
    assert.equal(result.items[0].respondedAt, '2026-10-21T11:00:00.000Z');
    assert.equal(result.items[0].presence, 'unknown');
    assert.equal(result.campaign.counters.responded, 1);
    assert.equal((await service.results('list','campaign','tenant',{ response:'no' })).total, 0);
    await assert.rejects(service.results('list','foreign-tenant-campaign','tenant'), /Campanha não encontrada/);
    await db.query('INSERT INTO campaign_messages VALUES ($1,$2,$3,$4)', ['duplicate', 'foreign-tenant-campaign', 'outgoing', message]);
    assert.equal((await service.results('list','campaign','tenant')).items[0].textReplies.length, 0);
    await db.query("DELETE FROM campaign_messages WHERE id='duplicate'");
    for (let i=0;i<100;i++) await add();
    await assert.rejects(service.results('list','campaign','tenant'), /Mais de 100 respostas/);
  } finally { await db.end(); }
});
