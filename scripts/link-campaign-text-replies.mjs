import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

/** Explicit reviewed IDs only. No phone/time based classification and no raw payload mutation. */
export async function linkCampaignTextReplies(db, input, apply = false) {
  const { actorUserId, clientId, listId, campaignId, reason, authorization, links } = input;
  for (const value of [actorUserId, clientId, listId, campaignId, reason, authorization]) {
    if (typeof value !== 'string' || !value.trim() || value.length > 2000) throw new Error('Identificação, motivo e autorização explícitos são obrigatórios');
  }
  if (!Array.isArray(links) || links.length < 1 || links.length > 100 ||
      links.some(l => !l || typeof l.messageId !== 'string' || !l.messageId || typeof l.campaignMessageId !== 'string' || !l.campaignMessageId) ||
      new Set(links.map(l => l.messageId)).size !== links.length) throw new Error('Informe IDs explícitos únicos (1–100)');
  await db.query('BEGIN');
  try {
    const { rows: states } = await db.query('SELECT state_json FROM app_state WHERE id=1 FOR SHARE');
    const state = typeof states[0]?.state_json === 'string' ? JSON.parse(states[0].state_json) : states[0]?.state_json;
    const actor = state?.users?.find(u => u.id === actorUserId && u.status === 'active' && ['super_admin', 'admin'].includes(u.role));
    if (!actor) throw new Error('Ator deve ser administrador ativo');
    const campaign = state.campaigns?.find(c => c.id === campaignId && c.clientId === clientId && c.listId === listId);
    const integration = state.integrations?.find(i => i.id === campaign?.integrationId);
    if (!campaign || !integration?.phoneNumberId) throw new Error('Campanha/tenant/lista/integração divergentes');
    const { rows: lists } = await db.query('SELECT id FROM lists WHERE id=$1 AND client_id=$2 FOR SHARE', [listId, clientId]);
    if (lists.length !== 1) throw new Error('Lista fora do tenant');
    const result = [];
    for (const link of [...links].sort((a,b) => a.messageId.localeCompare(b.messageId))) {
      const { rows: events } = await db.query("SELECT id, provider_message_id, received_at, record_json FROM message_events WHERE provider_message_id=$1 AND event_type='meta.inbound' FOR UPDATE", [link.messageId]);
      if (events.length !== 1) throw new Error('Evento inexistente ou ambíguo');
      const event = events[0];
      const { rows: messages } = await db.query('SELECT id,campaign_id,provider_message_id,record_json FROM campaign_messages WHERE id=$1 AND campaign_id=$2 FOR SHARE', [link.campaignMessageId, campaignId]);
      const sent = messages[0];
      if (!sent?.provider_message_id) throw new Error('Envio não comprovado nesta campanha');
      const phone = String(sent.record_json.phoneE164 ?? '').replace(/\D/g,'');
      const matches = [];
      for (const entry of event.record_json.payload?.entry ?? []) for (const change of entry.changes ?? []) {
        for (const inbound of change.value?.messages ?? []) if (inbound.id === link.messageId) matches.push({ inbound, receiver: change.value?.metadata?.phone_number_id });
      }
      if (matches.length !== 1) throw new Error('Payload do evento ambíguo');
      const { inbound, receiver } = matches[0];
      const sentAt = Date.parse(sent.record_json.sentAt ?? sent.record_json.createdAt);
      if (inbound.type !== 'text' || typeof inbound.text?.body !== 'string' || !inbound.text.body.trim() || inbound.text.body.length > 4096 ||
          inbound.context?.id != null || !/^[0-9]{7,15}$/.test(inbound.from ?? '') || inbound.from !== phone || receiver !== integration.phoneNumberId ||
          !Number.isFinite(sentAt) || new Date(event.received_at).getTime() < sentAt) throw new Error('Contexto, tipo, remetente, receptor ou horário divergente');
      const previous = event.record_json.manualCampaignAssociation;
      const association = { clientId, listId, campaignId, campaignMessageId: sent.id, integrationId: integration.id, phoneNumberId: integration.phoneNumberId, auditLogId: previous?.auditLogId ?? randomUUID() };
      if (previous) {
        const { rows: audits } = await db.query('SELECT record_json FROM audit_logs WHERE id=$1', [previous.auditLogId]);
        const audit = audits[0]?.record_json;
        const same = obj => obj && Object.keys(obj).length === Object.keys(association).length && Object.entries(association).every(([k,v]) => obj[k] === v);
        if (!same(previous) || audit?.action !== 'campaign.text_reply.linked' || audit.entityType !== 'message_event' || audit.entityId !== link.messageId || !audit.actorUserId || !same(audit.metadata?.association)) throw new Error('Associação/auditoria divergente; reatribuição proibida');
        result.push({ messageId: link.messageId, campaignMessageId: sent.id, status: 'already-linked' });
        continue;
      }
      const now = new Date().toISOString();
      const audit = { id: association.auditLogId, actorUserId, action: 'campaign.text_reply.linked', entityType: 'message_event', entityId: link.messageId,
        metadata: { association, reason, authorization }, createdAt: now };
      if (apply) {
        await db.query('INSERT INTO audit_logs (id,created_at,record_json) VALUES ($1,$2,$3)', [audit.id, now, audit]);
        await db.query("UPDATE message_events SET record_json=jsonb_set(record_json,'{manualCampaignAssociation}',$2::jsonb) WHERE id=$1", [event.id, JSON.stringify(association)]);
      }
      result.push({ messageId: link.messageId, campaignMessageId: sent.id, status: apply ? 'linked' : 'validated' });
    }
    await db.query(apply ? 'COMMIT' : 'ROLLBACK');
    return { applied: apply, campaignId, clientId, listId, items: result };
  } catch (error) { await db.query('ROLLBACK'); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file || process.argv.slice(3).some(arg => arg !== '--apply')) throw new Error('Uso: node scripts/link-campaign-text-replies.mjs manifest.json [--apply]');
  const input = JSON.parse(await readFile(file, 'utf8'));
  const connectionString = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Destino PostgreSQL explícito obrigatório');
  const db = new pg.Client({ connectionString });
  await db.connect();
  try { console.log(JSON.stringify(await linkCampaignTextReplies(db, input, process.argv.includes('--apply')), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Falha na classificação'); process.exitCode=1; }
  finally { await db.end(); }
}
