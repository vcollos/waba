import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { linkCampaignTextReplies } from './link-campaign-text-replies.mjs';
import { PublicCampaignsService } from '../apps/api/dist/api-tokens/public-campaigns.service.js';

// Only a disposable local PostgreSQL: fixtures are session-local TEMP tables.
const url = process.env.WABA_TEST_DATABASE_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('Use PostgreSQL local isolado');
test('respostas textuais: SQL real isola contexto, remetente, integração e campanha', { skip: !url }, async () => {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    await db.query(`CREATE TEMP TABLE campaign_messages (id text, campaign_id text, provider_message_id text, record_json jsonb);
      CREATE TEMP TABLE audit_logs (id text,created_at timestamptz,record_json jsonb);
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

test('classificação manual auditada: transação, escopo, imutabilidade, idempotência e reader', { skip: !url }, async () => {
  const db = new pg.Client({ connectionString: url }); await db.connect();
  try {
    await db.query(`CREATE TEMP TABLE app_state (id integer,state_json jsonb);
      CREATE TEMP TABLE lists (id text,client_id text,name text);
      CREATE TEMP TABLE campaign_messages (id text,campaign_id text,provider_message_id text,record_json jsonb);
      CREATE TEMP TABLE message_events (id text,provider_message_id text,event_type text,received_at timestamptz,record_json jsonb);
      CREATE TEMP TABLE audit_logs (id text PRIMARY KEY,created_at timestamptz,record_json jsonb)`);
    const campaign = { id:'campaign',clientId:'tenant',listId:'list',integrationId:'shared',mode:'template',createdAt:'2026-10-21T10:00:00Z' };
    const state = { campaigns:[campaign],integrations:[{id:'shared',phoneNumberId:'receiver'}],templates:[],flows:[],users:[{id:'admin',role:'super_admin',status:'active'}] };
    const sent = { id:'out', campaignId:'campaign',providerMessageId:'provider',phoneE164:'+5511999999999',createdAt:campaign.createdAt,status:'sent',contactId:'contact' };
    const payload = { entry:[{changes:[{value:{metadata:{phone_number_id:'receiver'},messages:[{id:'in',from:'5511999999999',type:'text',text:{body:'CPF sintético 00000000000'}}]}}]}] };
    const eventRecord = { payload, campaignMessageId:'heuristic-wrong' };
    await db.query('INSERT INTO app_state VALUES (1,$1)',[state]); await db.query("INSERT INTO lists VALUES ('list','tenant','List')");
    await db.query("INSERT INTO campaign_messages VALUES ('out','campaign','provider',$1)",[sent]);
    await db.query("INSERT INTO message_events VALUES ('event','in','meta.inbound','2026-10-21T11:00:00Z',$1)",[eventRecord]);
    const input = { actorUserId:'admin',clientId:'tenant',listId:'list',campaignId:'campaign',reason:'Resposta conferida',authorization:'Autorização humana específica',links:[{messageId:'in',campaignMessageId:'out'}] };
    const service = new PublicCampaignsService({ readMetaSnapshot:async()=>state,listCampaignMessagesInDatabase:async()=>[sent],listFlowResponsesInDatabase:async()=>[],postgresQuery:async(sql,args)=>sql.includes('FROM contacts')?[]:(await db.query(sql,args)).rows });
    assert.equal((await service.results('list','campaign','tenant')).items[0].textReplies.length,0);
    assert.equal((await linkCampaignTextReplies(db,input)).items[0].status,'validated');
    assert.deepEqual((await db.query('SELECT record_json FROM message_events')).rows[0].record_json,eventRecord);
    for (const patch of [{actorUserId:'other'},{clientId:'other'},{listId:'other'},{links:[{messageId:'in',campaignMessageId:'foreign'}]}]) {
      await assert.rejects(linkCampaignTextReplies(db,{...input,...patch},true));
    }
    for (const patch of [
      {from:'5511888888888'}, {context:{id:'provider'}}, {type:'image'},
    ]) {
      const broken = structuredClone(eventRecord); Object.assign(broken.payload.entry[0].changes[0].value.messages[0],patch);
      await db.query('UPDATE message_events SET record_json=$1',[broken]); await assert.rejects(linkCampaignTextReplies(db,input,true));
    }
    const wrongReceiver=structuredClone(eventRecord); wrongReceiver.payload.entry[0].changes[0].value.metadata.phone_number_id='foreign';
    await db.query('UPDATE message_events SET record_json=$1',[wrongReceiver]); await assert.rejects(linkCampaignTextReplies(db,input,true));
    await db.query("UPDATE message_events SET record_json=$1,received_at='2026-10-21T09:00:00Z'",[eventRecord]); await assert.rejects(linkCampaignTextReplies(db,input,true));
    await db.query("UPDATE message_events SET received_at='2026-10-21T11:00:00Z'");
    await db.query("UPDATE app_state SET state_json=jsonb_set(state_json,'{users,0,status}','\"inactive\"')"); await assert.rejects(linkCampaignTextReplies(db,input,true));
    await db.query('UPDATE app_state SET state_json=$1',[state]);
    await assert.rejects(linkCampaignTextReplies(db,{...input,links:[...input.links,{messageId:'z-missing',campaignMessageId:'out'}]},true));
    assert.equal((await db.query('SELECT count(*)::int n FROM audit_logs')).rows[0].n,0);
    assert.deepEqual((await db.query('SELECT record_json FROM message_events')).rows[0].record_json,eventRecord);
    assert.equal((await linkCampaignTextReplies(db,input,true)).items[0].status,'linked');
    const stored=(await db.query('SELECT record_json FROM message_events')).rows[0].record_json;
    assert.deepEqual(stored.payload,payload); assert.equal(stored.campaignMessageId,'heuristic-wrong');
    assert.equal((await service.results('list','campaign','tenant')).items[0].textReplies.length,1);
    assert.equal((await linkCampaignTextReplies(db,input,true)).items[0].status,'already-linked');
    assert.equal((await db.query('SELECT count(*)::int n FROM audit_logs')).rows[0].n,1);
    const originalAudit=(await db.query('SELECT record_json FROM audit_logs')).rows[0].record_json;
    for (const patch of [{actorUserId:''},{action:'other'},{metadata:{association:{...stored.manualCampaignAssociation,campaignId:'foreign'}}}]) {
      await db.query('UPDATE audit_logs SET record_json=$1',[{...originalAudit,...patch}]);
      assert.equal((await service.results('list','campaign','tenant')).items[0].textReplies.length,0);
      await assert.rejects(linkCampaignTextReplies(db,input,true),/divergente/);
    }
    await db.query('UPDATE audit_logs SET record_json=$1',[originalAudit]);
    await db.query("UPDATE audit_logs SET record_json=jsonb_set(record_json,'{entityId}','\"foreign\"')");
    assert.equal((await service.results('list','campaign','tenant')).items[0].textReplies.length,0);
    await assert.rejects(linkCampaignTextReplies(db,input,true),/divergente/);
    await db.query("UPDATE audit_logs SET record_json=jsonb_set(record_json,'{entityId}','\"in\"')");
    await db.query("UPDATE message_events SET record_json=jsonb_set(record_json,'{manualCampaignAssociation,clientId}','\"foreign\"')");
    assert.equal((await service.results('list','campaign','tenant')).items[0].textReplies.length,0);
    await assert.rejects(linkCampaignTextReplies(db,input,true),/divergente/);
  } finally { await db.end(); }
});
