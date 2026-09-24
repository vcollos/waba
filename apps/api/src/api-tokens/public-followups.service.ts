import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { approvedTemplateFingerprint, CampaignsService } from '../campaigns/campaigns.service';
import { DatabaseService } from '../database/database.service';
import { hash, newId, nowIso } from '../database/helpers';
import type { CampaignMessageRecord, CampaignRecord, ContactRecord, FlowResponseRecord, TemplateCacheRecord } from '../database/types';
import { campaignIdentity } from './public-campaigns.service';

export interface FollowupGroupInput {
  integrationId: string;
  templateId: string;
  flowId: string;
}

interface PreparedFollowup {
  group: FollowupGroupInput & { templateName: string; flowName: string | null; sourceCampaignId: string; sourceCampaignName: string; mappingVariants: boolean };
  campaignIds: string[];
  counts: {
    sentPeople: number;
    responded: number;
    eligible: number;
    excluded: { responded: number; notInList: number; inactive: number; optedOut: number; invalidPhone: number; duplicatePhone: number };
  };
  previewHash: string;
  currentTemplate: { id: string; name: string; languageCode: string; lastSyncedAt: string; components: unknown[] };
  historicalContentVerified: false;
  source: CampaignRecord;
  template: TemplateCacheRecord;
  contacts: ContactRecord[];
}
type ResponseIdentity = Pick<FlowResponseRecord, 'integrationId' | 'campaignMessageId' | 'contactId' | 'waId'>;

const phoneKey = (value: string | null | undefined) => String(value ?? '').replace(/\D/g, '');
const sentEvidence = (message: CampaignMessageRecord) => Boolean(
  message.sentAt || message.deliveredAt || message.readAt ||
  ['sent', 'delivered', 'read'].includes(message.status),
);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
const MAX_GROUP_MESSAGES = 5_000;
const MAX_GROUP_RESPONSES = 5_000;
const CONTACT_PHONE_BATCH = 250;

/** Lê a audiência de todo o grupo e cria uma execução nova, sem alterar as anteriores. */
@Injectable()
export class PublicFollowupsService {
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(
    private readonly database: DatabaseService,
    private readonly campaigns: CampaignsService,
    private readonly audit: AuditService,
  ) {}

  async preview(listId: string, clientId: string, input: FollowupGroupInput) {
    const { source: _source, template: _template, contacts: _contacts, ...publicPreview } =
      await this.prepare(listId, clientId, input);
    return publicPreview;
  }

  async execute(
    listId: string,
    clientId: string,
    input: FollowupGroupInput & { previewHash?: string; confirm?: boolean },
    idempotencyKey: string | undefined,
    actorId: string,
  ) {
    if (!input || typeof input !== 'object') throw new BadRequestException('Grupo inválido');
    if (input.confirm !== true) throw new BadRequestException('Confirmação explícita obrigatória');
    if (typeof input.previewHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.previewHash)) {
      throw new BadRequestException('Prévia inválida');
    }
    if (!idempotencyKey || !/^[\w:.-]{8,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key obrigatória (8 a 128 caracteres)');
    }
    const requestKeyHash = hash(`${clientId}\u0000${idempotencyKey}`);
    const inFlight = this.pending.get(requestKeyHash);
    if (inFlight) return inFlight;
    const task = this.executeOnce(listId, clientId, { ...input, previewHash: input.previewHash }, requestKeyHash, actorId);
    this.pending.set(requestKeyHash, task);
    try { return await task; } finally { this.pending.delete(requestKeyHash); }
  }

  private async executeOnce(
    listId: string,
    clientId: string,
    input: FollowupGroupInput & { previewHash: string },
    requestKeyHash: string,
    actorId: string,
  ) {
    // Antes de devolver uma repetição, valida novamente o escopo da lista.
    await this.assertListScope(listId, clientId);
    const previous = (await this.database.readMeta()).campaigns.find((item) => item.followupRequestKeyHash === requestKeyHash);
    if (previous) {
      if (previous.clientId !== clientId || previous.listId !== listId || previous.followupPreviewHash !== input.previewHash ||
          previous.integrationId !== input.integrationId || previous.metaTemplateId !== input.templateId || previous.metaFlowId !== input.flowId) {
        throw new ConflictException('Chave de idempotência já usada para outro reenvio');
      }
      if (previous.status === 'draft') {
        const current = await this.prepare(listId, clientId, input);
        if (current.previewHash !== input.previewHash) {
          await this.database.write((state) => {
            const draft = state.campaigns.find((item) => item.id === previous.id);
            if (draft?.status === 'draft') { draft.status = 'cancelled'; draft.updatedAt = nowIso(); }
          });
          await this.audit.log({ actorUserId: actorId, action: 'campaign.followup_draft_cancelled',
            entityType: 'campaign', entityId: previous.id, metadata: { reason: 'audience_changed' } });
          throw new ConflictException('A audiência mudou; o rascunho foi cancelado. Atualize a prévia');
        }
        return this.queuePrepared(previous, current, actorId, true);
      }
      if (previous.status === 'cancelled' || previous.status === 'failed') {
        throw new ConflictException('Esta chave pertence a um reenvio cancelado; gere nova prévia e chave');
      }
      return { campaignId: previous.id, status: 'queued' as const, currentStatus: previous.status,
        recipientCount: previous.audienceSnapshot.selectedCount, replayed: true };
    }
    const prepared = await this.prepare(listId, clientId, input);
    if (prepared.previewHash !== input.previewHash) throw new ConflictException('A audiência mudou; atualize a prévia antes de confirmar');
    if (prepared.contacts.length === 0) throw new BadRequestException('Nenhum contato elegível para reenvio');

    const createdAt = nowIso();
    const campaign: CampaignRecord = {
      ...structuredClone(prepared.source),
      id: newId(),
      name: `${prepared.source.name} · reenvio sem resposta ${createdAt.slice(0, 16)}`,
      clientId,
      templateCacheId: prepared.template.id,
      flowCacheId: (await this.database.readMeta()).flows.find((flow) => flow.integrationId === input.integrationId && flow.metaFlowId === input.flowId)?.id ?? null,
      metaTemplateId: input.templateId,
      metaFlowId: input.flowId,
      listId,
      followupSourceCampaignId: prepared.source.id,
      followupRequestKeyHash: requestKeyHash,
      followupPreviewHash: input.previewHash,
      followupTemplateFingerprint: approvedTemplateFingerprint(prepared.template),
      status: 'draft',
      summary: { total: 0, pending: 0, accepted: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 },
      audienceSnapshot: {
        listMembersTotal: prepared.counts.sentPeople,
        eligibleCount: prepared.contacts.length,
        afterFilterCount: prepared.contacts.length,
        afterCategoryFilterCount: prepared.contacts.length,
        afterResendFilterCount: prepared.contacts.length,
        afterUniqueWhatsAppFilterCount: prepared.contacts.length,
        excludedByFilter: 0, excludedByCategory: 0, excludedByUniqueWhatsApp: 0,
        excludedByResendPolicy: 0, selectedCount: prepared.contacts.length,
      },
      scheduledAt: null, startedAt: null, finishedAt: null,
      createdAt, updatedAt: createdAt,
    };

    // DatabaseService.write serializa a reserva da chave no processo que opera o poller.
    let reserved = false;
    let cancelledDraftId: string | null = null;
    await this.database.write((state) => {
      const duplicate = state.campaigns.find((item) => item.followupRequestKeyHash === requestKeyHash);
      if (duplicate) throw new ConflictException('Reenvio já criado com esta chave');
      const active = state.campaigns.find((item) => item.clientId === clientId && item.listId === listId &&
        item.integrationId === input.integrationId && campaignIdentity(item, state).templateId === input.templateId &&
        campaignIdentity(item, state).flowId === input.flowId &&
        item.followupSourceCampaignId && ['draft', 'queued', 'sending'].includes(item.status));
      if (active?.status === 'draft') {
        active.status = 'cancelled'; active.updatedAt = nowIso(); cancelledDraftId = active.id;
      } else if (active) {
        throw new ConflictException('Já existe reenvio em preparação ou envio para este grupo');
      }
      state.campaigns.push(campaign);
      reserved = true;
    });
    if (!reserved) throw new ConflictException('Não foi possível reservar o reenvio');
    if (cancelledDraftId) await this.audit.log({ actorUserId: actorId, action: 'campaign.followup_draft_cancelled',
      entityType: 'campaign', entityId: cancelledDraftId, metadata: { reason: 'new_preview' } });

    return this.queuePrepared(campaign, prepared, actorId, false);
  }

  private async queuePrepared(campaign: CampaignRecord, prepared: PreparedFollowup, actorId: string, replayed: boolean) {
    const createdAt = nowIso();
    const messages: CampaignMessageRecord[] = prepared.contacts.map((contact) => {
      const flowToken = `cmp_${campaign.id}_ctt_${contact.id}`;
      const payload = this.campaigns.buildTemplatePayload(campaign, prepared.template, contact, flowToken);
      return { id: newId(), campaignId: campaign.id, contactId: contact.id, phoneE164: contact.phoneE164,
        status: 'pending', payload, payloadHash: hash(JSON.stringify(payload)), flowToken,
        attemptCount: 0, nextAttemptAt: null, lastAttemptAt: null, createdAt, updatedAt: createdAt };
    });
    await this.database.replaceCampaignMessagesForCampaignInDatabase(campaign.id, messages);
    await this.campaigns.refreshCampaignSummary(campaign.id);
    const latest = await this.prepare(campaign.listId, campaign.clientId!, {
      integrationId: campaign.integrationId, templateId: campaign.metaTemplateId!, flowId: campaign.metaFlowId!,
    });
    if (latest.previewHash !== campaign.followupPreviewHash) {
      await this.database.write((state) => {
        const item = state.campaigns.find((entry) => entry.id === campaign.id);
        if (item?.status === 'draft') { item.status = 'cancelled'; item.updatedAt = nowIso(); }
      });
      await this.audit.log({ actorUserId: actorId, action: 'campaign.followup_draft_cancelled',
        entityType: 'campaign', entityId: campaign.id, metadata: { reason: 'audience_changed_before_queue' } });
      throw new ConflictException('A audiência mudou antes do envio; atualize a prévia');
    }
    await this.database.write((state) => {
      const item = state.campaigns.find((entry) => entry.id === campaign.id);
      if (!item || item.status !== 'draft') throw new ConflictException('Reenvio alterado durante a preparação');
      item.status = 'queued';
      item.startedAt = nowIso();
      item.updatedAt = item.startedAt;
    });
    await this.audit.log({ actorUserId: actorId, action: 'campaign.followup_unanswered_created', entityType: 'campaign',
      entityId: campaign.id, metadata: { sourceCampaignId: prepared.source.id, groupCampaignIds: prepared.campaignIds,
        recipientCount: messages.length, listId: campaign.listId } });
    return { campaignId: campaign.id, status: 'queued' as const, recipientCount: messages.length, replayed };
  }

  private async prepare(listId: string, clientId: string, input: FollowupGroupInput): Promise<PreparedFollowup> {
    if (!input || typeof input !== 'object' || !validId(listId) || !validId(clientId) || !validId(input.integrationId) ||
        !validId(input.templateId) || !validId(input.flowId)) throw new BadRequestException('Grupo inválido');
    const groupKey = { integrationId: input.integrationId, templateId: input.templateId, flowId: input.flowId };
    await this.assertListScope(listId, clientId);
    const state = await this.database.readMetaSnapshot();
    if (!state.clientIntegrations.some((link) => link.clientId === clientId && link.integrationId === input.integrationId)) {
      throw new NotFoundException('Integração não encontrada');
    }
    const group = state.campaigns.filter((item) => {
      const identity = campaignIdentity(item, state);
      return item.clientId === clientId && item.listId === listId &&
        item.integrationId === input.integrationId && identity.templateId === input.templateId &&
        identity.flowId === input.flowId && identity.flowIdentityStatus === 'resolved' &&
        !item.id.startsWith('svc:') &&
        !(item.followupSourceCampaignId && (item.status === 'draft' ||
          (item.status === 'cancelled' && !((item.summary?.accepted ?? 0) + (item.summary?.sent ?? 0) +
            (item.summary?.delivered ?? 0) + (item.summary?.read ?? 0)))));
    });
    if (group.length === 0) throw new NotFoundException('Campanhas do grupo não encontradas');
    if (group.length > 20) throw new BadRequestException('Grupo acima do limite de 20 execuções');
    const ordered = [...group].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const template = state.templates.find((item) => item.integrationId === input.integrationId && item.metaTemplateId === input.templateId &&
      String(item.status).toUpperCase() === 'APPROVED' && (!item.clientId || item.clientId === clientId));
    if (!template || !template.hasFlowButton || String(template.flowButtonMeta?.flow_id ?? '') !== input.flowId) {
      throw new ConflictException('Template aprovado e Flow deste grupo não estão disponíveis para reenvio');
    }
    const flow = state.flows.find((item) => item.integrationId === input.integrationId && item.metaFlowId === input.flowId);

    const campaignIds = group.map((item) => item.id).sort();
    const [volume] = await this.database.postgresQuery<{ message_count: string; response_count: string }>(
      `SELECT
        (SELECT COUNT(*) FROM (SELECT 1 FROM campaign_messages WHERE campaign_id = ANY($1::text[]) LIMIT ${MAX_GROUP_MESSAGES + 1}) m) AS message_count,
        (SELECT COUNT(*) FROM (SELECT 1 FROM flow_responses WHERE campaign_id = ANY($1::text[]) LIMIT ${MAX_GROUP_RESPONSES + 1}) r) AS response_count`,
      [campaignIds],
    );
    const messageCount = Number(volume?.message_count);
    const responseCount = Number(volume?.response_count);
    if (!Number.isInteger(messageCount) || !Number.isInteger(responseCount) ||
        messageCount > MAX_GROUP_MESSAGES || responseCount > MAX_GROUP_RESPONSES) {
      throw new BadRequestException('Grupo acima do limite de mensagens ou respostas para prévia');
    }
    const messagesByCampaign: CampaignMessageRecord[][] = [];
    const responsesByCampaign: FlowResponseRecord[][] = [];
    let loadedMessages = 0;
    let loadedResponses = 0;
    for (const item of group) {
      const messages = await this.database.listCampaignMessagesInDatabase({ campaignId: item.id, limit: MAX_GROUP_MESSAGES + 1 });
      loadedMessages += messages.length;
      if (loadedMessages > MAX_GROUP_MESSAGES) throw new BadRequestException('Grupo acima do limite de mensagens para prévia');
      messagesByCampaign.push(messages);
      const responses = await this.database.listFlowResponsesInDatabase({ campaignId: item.id, limit: MAX_GROUP_RESPONSES + 1 });
      loadedResponses += responses.length;
      if (loadedResponses > MAX_GROUP_RESPONSES) throw new BadRequestException('Grupo acima do limite de respostas para prévia');
      responsesByCampaign.push(responses);
    }
    const hasTemplateSend = (message: CampaignMessageRecord) => {
      const value = message.payload.template;
      return sentEvidence(message) && value && typeof value === 'object' && !Array.isArray(value) &&
        String((value as Record<string, unknown>).name ?? '') === template.name;
    };
    const sentCampaignIds = new Set(group.filter((_, index) => messagesByCampaign[index].some(hasTemplateSend)).map((item) => item.id));
    const source = ordered.find((item) => sentCampaignIds.has(item.id));
    if (!source) throw new ConflictException('Grupo sem execução do template aprovado para repetir');
    const mappingVariants = group.some((item) => JSON.stringify(item.parameterMapping) !== JSON.stringify(source.parameterMapping));
    const sent = messagesByCampaign.flat().filter(sentEvidence);
    const templateNames = new Set(sent.map((message) => {
      const value = message.payload.template;
      return value && typeof value === 'object' && !Array.isArray(value) ? String((value as Record<string, unknown>).name ?? '') : '';
    }));
    if (sent.length > 0 && (templateNames.size !== 1 || !templateNames.has(template.name))) {
      throw new ConflictException('O nome do template enviado difere do template aprovado atual');
    }
    const sentByPhone = new Map<string, CampaignMessageRecord>();
    for (const message of sent) {
      const key = phoneKey(message.phoneE164);
      if (key) sentByPhone.set(key, message);
    }
    const messagePhone = new Map(sent.map((message) => [message.id, phoneKey(message.phoneE164)]));
    const contactPhones = new Map<string, Set<string>>();
    for (const message of sent) {
      const phones = contactPhones.get(message.contactId) ?? new Set<string>();
      phones.add(phoneKey(message.phoneE164));
      contactPhones.set(message.contactId, phones);
    }
    const responses: ResponseIdentity[] = responsesByCampaign.flat().filter((response) => response.integrationId === input.integrationId);
    if (sentByPhone.size > 0) {
      const phoneKeys = [...sentByPhone.keys()];
      const contactIds = [...contactPhones.keys()];
      const remaining = MAX_GROUP_RESPONSES - loadedResponses;
      const parameters = [input.integrationId, input.flowId, phoneKeys, contactIds, remaining + 1];
      const unlinkedFilter = `fr.campaign_id IS NULL AND fr.integration_id = $1 AND fr.meta_flow_id = $2
        AND (regexp_replace(COALESCE(fr.record_json->>'waId', ''), '[^0-9]', '', 'g') = ANY($3::text[])
          OR fr.contact_id = ANY($4::text[]))`;
      const [unlinkedVolume] = await this.database.postgresQuery<{ response_count: string }>(
        `SELECT COUNT(*) AS response_count FROM (
          SELECT 1 FROM flow_responses fr WHERE ${unlinkedFilter} LIMIT $5
        ) bounded`, parameters);
      const unlinkedCount = Number(unlinkedVolume?.response_count);
      if (!Number.isInteger(unlinkedCount) || unlinkedCount > remaining) {
        throw new BadRequestException('Grupo acima do limite de respostas para prévia');
      }
      if (unlinkedCount > 0) {
        const unlinked = await this.database.postgresQuery<{
          id: string; campaign_message_id: string | null; contact_id: string | null; wa_id: string | null;
        }>(
          `SELECT fr.id, fr.campaign_message_id, fr.contact_id, fr.record_json->>'waId' AS wa_id
           FROM flow_responses fr WHERE ${unlinkedFilter} ORDER BY fr.completed_at DESC LIMIT $5`, parameters);
        if (unlinked.length > remaining) throw new BadRequestException('Grupo acima do limite de respostas para prévia');
        responses.push(...unlinked.map((row) => ({ integrationId: input.integrationId,
          campaignMessageId: row.campaign_message_id, contactId: row.contact_id, waId: row.wa_id ?? '' })));
      }
    }
    const respondedPhones = new Set<string>();
    for (const response of responses) {
      const byMessage = messagePhone.get(response.campaignMessageId ?? '');
      if (byMessage) respondedPhones.add(byMessage);
      for (const key of contactPhones.get(response.contactId ?? '') ?? []) if (key) respondedPhones.add(key);
      const waId = phoneKey(response.waId);
      if (waId && sentByPhone.has(waId)) respondedPhones.add(waId);
    }

    const rows: Record<string, unknown>[] = [];
    const phoneCandidates = [...sentByPhone.keys()].flatMap((key) => [`+${key}`, key]);
    for (let offset = 0; offset < phoneCandidates.length; offset += CONTACT_PHONE_BATCH) {
      rows.push(...await this.database.postgresQuery<Record<string, unknown>>(
        `SELECT c.id, c.external_ref, c.client_name, c.first_name, c.last_name, c.name, c.category, c.record_status,
              c.phone_raw, c.phone_e164, c.phone_hash, c.email, c.attributes_json, c.is_valid, c.validation_error,
              c.is_opted_out, c.opted_out_at, c.opt_out_source, c.imported_at, c.created_at, c.updated_at,
              (lm.contact_id IS NOT NULL) AS in_list
       FROM contacts c
       LEFT JOIN list_members lm ON lm.contact_id = c.id AND lm.list_id = $1
       WHERE c.client_id = $2 AND c.phone_e164 = ANY($3::text[])
       ORDER BY c.updated_at DESC, c.id`, [listId, clientId, phoneCandidates.slice(offset, offset + CONTACT_PHONE_BATCH)]));
    }
    const currentByPhone = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      const key = phoneKey(String(row.phone_e164 ?? ''));
      if (!key) continue;
      const existing = currentByPhone.get(key) ?? [];
      existing.push(row);
      currentByPhone.set(key, existing);
    }
    const excluded = { responded: 0, notInList: 0, inactive: 0, optedOut: 0, invalidPhone: 0, duplicatePhone: sent.length - sentByPhone.size };
    const contacts: ContactRecord[] = [];
    for (const [key] of sentByPhone) {
      if (respondedPhones.has(key)) { excluded.responded++; continue; }
      const matches = currentByPhone.get(key) ?? [];
      if (matches.some((row) => row.is_opted_out === true || row.is_opted_out === 1)) {
        excluded.optedOut++; continue;
      }
      const members = matches.filter((row) => row.in_list === true || row.in_list === 1);
      if (!members.length) { excluded.notInList++; continue; }
      const active = members.filter((row) => String(row.record_status) === 'active');
      if (!active.length) { excluded.inactive++; continue; }
      const row = active.find((item) => item.is_valid === true || item.is_valid === 1);
      if (!row) { excluded.invalidPhone++; continue; }
      const contact = mapContact(row);
      if (!contact.phoneE164 || phoneKey(contact.phoneE164) !== key) { excluded.invalidPhone++; continue; }
      contacts.push(contact);
    }
    contacts.sort((a, b) => a.phoneE164.localeCompare(b.phoneE164));
    const counts = { sentPeople: sentByPhone.size, responded: excluded.responded, eligible: contacts.length, excluded };
    const previewHash = hash(JSON.stringify({ clientId, listId, groupKey, campaignIds, sourceCampaignId: source.id,
      mappingVariants, template: { id: template.id, name: template.name, languageCode: template.languageCode,
        status: template.status, components: template.components, variableDescriptors: template.variableDescriptors,
        flowButtonMeta: template.flowButtonMeta }, mapping: source.parameterMapping,
      audience: contacts, responded: [...respondedPhones].sort() }));
    return { group: { ...groupKey, templateName: template.name, flowName: flow?.name ?? null,
      sourceCampaignId: source.id, sourceCampaignName: source.name, mappingVariants },
      campaignIds, counts, previewHash,
      currentTemplate: { id: template.metaTemplateId, name: template.name, languageCode: template.languageCode,
        lastSyncedAt: template.lastSyncedAt, components: template.components },
      historicalContentVerified: false, source, template, contacts };
  }

  private async assertListScope(listId: string, clientId: string) {
    if (!validId(listId) || !validId(clientId)) throw new BadRequestException('Lista inválida');
    const [list] = await this.database.postgresQuery<{ id: string }>(
      'SELECT id FROM lists WHERE id = $1 AND client_id = $2', [listId, clientId]);
    if (!list) throw new NotFoundException('Lista não encontrada');
  }
}

function mapContact(row: Record<string, unknown>): ContactRecord {
  let attributes: Record<string, string> = {};
  try {
    const raw: unknown = typeof row.attributes_json === 'string' ? JSON.parse(row.attributes_json) : row.attributes_json;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) attributes = raw as Record<string, string>;
  } catch { /* dado legado inválido não deve ser usado em variáveis */ }
  return {
    id: String(row.id), externalRef: row.external_ref ? String(row.external_ref) : null,
    clientName: row.client_name ? String(row.client_name) : null,
    firstName: String(row.first_name ?? ''), lastName: row.last_name ? String(row.last_name) : null,
    name: String(row.name ?? ''), category: row.category ? String(row.category) : null,
    recordStatus: 'active', phoneRaw: String(row.phone_raw ?? ''), phoneE164: String(row.phone_e164 ?? ''),
    phoneHash: String(row.phone_hash ?? ''), email: row.email ? String(row.email) : null, attributes,
    isValid: true, validationError: null, isOptedOut: false, optedOutAt: null, optOutSource: null,
    importedAt: row.imported_at ? String(row.imported_at) : null,
    createdAt: String(row.created_at ?? nowIso()), updatedAt: String(row.updated_at ?? nowIso()),
  };
}
