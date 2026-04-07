import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { DatabaseService } from '../database/database.service';
import { hash, newId, nowIso, resolveParameterValue } from '../database/helpers';
import {
  CampaignAudienceConfig,
  CampaignAudienceOrderField,
  CampaignMessageRecord,
  CampaignRecord,
  ContactRecord,
  FlowCacheRecord,
  ParameterSource,
  TemplateCacheRecord,
  UserSession,
} from '../database/types';

export interface CreateCampaignInput {
  name: string;
  integrationId: string;
  listId: string;
  mode: CampaignRecord['mode'];
  templateCacheId?: string;
  flowCacheId?: string;
  sendRateMps?: number;
  parameterMapping?: Record<string, ParameterSource>;
  audience?: Partial<CampaignAudienceConfig>;
}

interface GetCampaignOptions {
  limit?: number;
  offset?: number;
}

@Injectable()
export class CampaignsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const state = await this.database.readMeta();
    const listsById = await this.loadListsByIds(state.campaigns.map((campaign) => campaign.listId));
    return state.campaigns
      .map((campaign) => ({
        ...campaign,
        template: state.templates.find((template) => template.id === campaign.templateCacheId) ?? null,
        list: listsById.get(campaign.listId) ?? null,
      }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getCampaign(id: string, options?: GetCampaignOptions) {
    const state = await this.database.readMeta();
    const campaign = state.campaigns.find((item) => item.id === id);
    if (!campaign) {
      throw new NotFoundException('Campanha não encontrada');
    }

    const template = campaign.templateCacheId
      ? state.templates.find((item) => item.id === campaign.templateCacheId) ?? null
      : null;
    const flow = campaign.flowCacheId
      ? state.flows.find((item) => item.id === campaign.flowCacheId) ?? null
      : null;
    const list = (await this.loadListsByIds([campaign.listId])).get(campaign.listId) ?? null;
    const limit = Math.max(1, Math.min(500, Number(options?.limit ?? 100)));
    const offset = Math.max(0, Number(options?.offset ?? 0));
    const [messagesTotal, pagedMessages] = await Promise.all([
      this.database.countCampaignMessagesInDatabase(id),
      this.database.listCampaignMessagesInDatabase({ campaignId: id, limit, offset }),
    ]);
    const contactsById = await this.loadContactsByIds(pagedMessages.map((message) => message.contactId));

    return {
      ...campaign,
      template,
      flow,
      list,
      messagesTotal,
      messagesLimit: limit,
      messagesOffset: offset,
      messagesHasMore: offset + pagedMessages.length < messagesTotal,
      messages: pagedMessages
        .map((message) => {
          const contact = contactsById.get(message.contactId) ?? null;
          return {
            ...message,
            contactFirstName: contact?.firstName ?? null,
            contactLastName: contact?.lastName ?? null,
            contactName: contact?.name ?? null,
            contactClientName: contact?.clientName ?? null,
            contactCategory: contact?.category ?? null,
            contactRecordStatus: contact?.recordStatus ?? null,
          };
        })
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    };
  }

  async create(input: CreateCampaignInput, actor: UserSession) {
    const state = await this.database.readMeta();
    const template = input.templateCacheId
      ? state.templates.find((item) => item.id === input.templateCacheId)
      : undefined;
    const inferredFlow = template?.hasFlowButton
      ? findFlowForTemplate(template, state.flows)
      : undefined;

    if (!state.integrations.some((item) => item.id === input.integrationId)) {
      throw new NotFoundException('Integração não encontrada');
    }
    if (!(await this.loadListsByIds([input.listId])).has(input.listId)) {
      throw new NotFoundException('Lista não encontrada');
    }
    if (input.templateCacheId && !template) {
      throw new NotFoundException('Template não encontrado');
    }

    const mapping = input.parameterMapping ?? {};
    if (template) {
      for (const descriptor of template.variableDescriptors) {
        const key = `${descriptor.componentType}:${descriptor.placeholderIndex}`;
        if (!mapping[key]) {
          mapping[key] = { type: 'contact_name' };
        }
      }
    }

    const campaign: CampaignRecord = {
      id: newId(),
      integrationId: input.integrationId,
      name: input.name,
      mode: input.mode,
      templateCacheId: input.templateCacheId ?? null,
      flowCacheId: input.flowCacheId ?? inferredFlow?.id ?? null,
      listId: input.listId,
      parameterMapping: mapping,
      audience: normalizeAudienceConfig(input.audience),
      audienceSnapshot: emptyAudienceSnapshot(),
      sendRateMps: Math.max(1, Math.min(80, Number(input.sendRateMps ?? 20))),
      status: 'draft',
      summary: emptySummary(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    await this.database.write((draft) => {
      draft.campaigns.push(campaign);
    });

    await this.prepareMessages(campaign.id);

    await this.audit.log({
      actorUserId: actor.id,
      action: 'campaign.created',
      entityType: 'campaign',
      entityId: campaign.id,
      metadata: {
        listId: campaign.listId,
        templateCacheId: campaign.templateCacheId,
        audience: campaign.audience,
      },
    });

    return this.getCampaign(campaign.id);
  }

  async start(id: string, actor: UserSession) {
    const state = await this.database.readMeta();
    const campaign = state.campaigns.find((item) => item.id === id);
    if (!campaign) {
      throw new NotFoundException('Campanha não encontrada');
    }

    const existingMessagesCount = await this.database.countCampaignMessagesInDatabase(id);
    if (existingMessagesCount === 0) {
      await this.prepareMessages(campaign.id);
    }

    const prepared = await this.getCampaign(id);
    if (prepared.summary.total === 0) {
      throw new BadRequestException('Campanha sem contatos elegíveis para envio');
    }

    if (prepared.summary.pending === 0 && prepared.summary.failed === 0) {
      throw new BadRequestException('Campanha não possui mensagens pendentes para envio');
    }

    await this.database.write((draft) => {
      const item = draft.campaigns.find((record) => record.id === id);
      if (!item) {
        throw new NotFoundException('Campanha não encontrada');
      }
      item.status = 'queued';
      item.startedAt = item.startedAt ?? nowIso();
      item.updatedAt = nowIso();
    });

    await this.audit.log({
      actorUserId: actor.id,
      action: 'campaign.started',
      entityType: 'campaign',
      entityId: id,
    });

    return this.getCampaign(id);
  }

  async pause(id: string, actor: UserSession) {
    await this.transitionStatus(id, 'paused', actor, 'campaign.paused');
    return this.getCampaign(id);
  }

  async resume(id: string, actor: UserSession) {
    const campaign = await this.getCampaign(id, { limit: 1 });
    if (campaign.summary.pending === 0 && campaign.summary.failed === 0) {
      throw new BadRequestException('Campanha não possui mensagens para retomar');
    }

    await this.transitionStatus(id, 'queued', actor, 'campaign.resumed');
    return this.getCampaign(id);
  }

  async retryFailed(id: string, actor: UserSession) {
    const retryAt = nowIso();
    const failedMessages = (await this.database.listCampaignMessagesInDatabase({ campaignId: id })).filter(
      (item) => item.status === 'failed',
    );
    await Promise.all(
      failedMessages.map((message) =>
        this.database.saveCampaignMessageInDatabase({
          ...message,
          status: 'pending',
          nextAttemptAt: retryAt,
          failedAt: null,
          updatedAt: retryAt,
        }),
      ),
    );

    await this.database.write((state) => {
      const campaign = state.campaigns.find((item) => item.id === id);
      if (campaign) {
        campaign.status = 'queued';
        campaign.updatedAt = retryAt;
      }
    });

    await this.audit.log({
      actorUserId: actor.id,
      action: 'campaign.retry_failed',
      entityType: 'campaign',
      entityId: id,
    });

    await this.refreshCampaignSummary(id);
    return this.getCampaign(id);
  }

  async retryUnansweredFlow(id: string, actor: UserSession) {
    const retryAt = nowIso();
    const state = await this.database.readMeta();
    const campaign = state.campaigns.find((item) => item.id === id);
    if (!campaign) {
      throw new NotFoundException('Campanha não encontrada');
    }
    if (['queued', 'sending'].includes(campaign.status)) {
      throw new BadRequestException('Pause a campanha antes de reenviar quem não respondeu ao flow');
    }

    const [messages, flowResponses] = await Promise.all([
      this.database.listCampaignMessagesInDatabase({ campaignId: id }),
      this.database.listFlowResponsesInDatabase({ campaignId: id }),
    ]);

    const flowMessages = messages.filter((item) => item.flowToken);
    if (flowMessages.length === 0) {
      throw new BadRequestException('Campanha não possui flow para reenvio');
    }

    const respondedMessageIds = new Set(
      flowResponses.map((item) => item.campaignMessageId).filter((item): item is string => Boolean(item)),
    );
    const respondedContactIds = new Set(
      flowResponses.map((item) => item.contactId).filter((item): item is string => Boolean(item)),
    );
    const retryableStatuses = new Set<CampaignMessageRecord['status']>(['accepted', 'sent', 'delivered', 'read']);
    const unansweredMessages = flowMessages.filter(
      (message) =>
        retryableStatuses.has(message.status) &&
        !respondedMessageIds.has(message.id) &&
        !respondedContactIds.has(message.contactId),
    );

    if (unansweredMessages.length === 0) {
      throw new BadRequestException('Campanha não possui contatos sem resposta do flow');
    }

    await Promise.all(
      unansweredMessages.map((message) =>
        this.database.saveCampaignMessageInDatabase({
          ...message,
          status: 'pending',
          providerMessageId: null,
          providerConversationId: null,
          providerErrorCode: null,
          providerErrorTitle: null,
          providerErrorMessage: null,
          nextAttemptAt: retryAt,
          sentAt: null,
          deliveredAt: null,
          readAt: null,
          failedAt: null,
          updatedAt: retryAt,
        }),
      ),
    );

    await this.database.write((draft) => {
      const item = draft.campaigns.find((record) => record.id === id);
      if (!item) {
        throw new NotFoundException('Campanha não encontrada');
      }
      item.status = 'queued';
      item.finishedAt = null;
      item.updatedAt = retryAt;
    });

    await this.audit.log({
      actorUserId: actor.id,
      action: 'campaign.retry_unanswered_flow',
      entityType: 'campaign',
      entityId: id,
      metadata: {
        retriedCount: unansweredMessages.length,
      },
    });

    await this.refreshCampaignSummary(id);
    return this.getCampaign(id);
  }

  async removeDraft(id: string, actor: UserSession) {
    const state = await this.database.readMeta();
    const campaign = state.campaigns.find((item) => item.id === id);
    if (!campaign) {
      throw new NotFoundException('Campanha não encontrada');
    }

    if (campaign.status !== 'draft') {
      throw new BadRequestException('Só é permitido excluir campanhas em rascunho');
    }

    const relatedMessageIds = new Set(
      (await this.database.listCampaignMessagesInDatabase({ campaignId: id })).map((message) => message.id),
    );

    await this.database.write((draft) => {
      draft.campaigns = draft.campaigns.filter((item) => item.id !== id);
    });
    await this.database.deleteCampaignOperationalDataInDatabase(id);

    await this.audit.log({
      actorUserId: actor.id,
      action: 'campaign.deleted_draft',
      entityType: 'campaign',
      entityId: id,
      metadata: {
        removedMessageCount: relatedMessageIds.size,
      },
    });

    return { deleted: true, id };
  }

  async prepareMessages(campaignId: string) {
    const state = await this.database.readMeta();
    const campaign = state.campaigns.find((item) => item.id === campaignId);
    if (!campaign) {
      throw new NotFoundException('Campanha não encontrada');
    }

    const template = campaign.templateCacheId
      ? state.templates.find((item) => item.id === campaign.templateCacheId)
      : undefined;
    const existingMessages = await this.database.listCampaignMessagesInDatabase();
    const selection = selectCampaignContacts(
      campaign,
      await this.loadContactsForList(campaign.listId),
      existingMessages,
    );
    const createdAt = nowIso();
    const nextMessages = selection.selectedContacts.map((contact) => {
      const flowToken = template?.hasFlowButton
        ? `cmp_${campaign.id}_ctt_${contact.id}`
        : null;
      const payload = this.buildTemplatePayload(campaign, template, contact, flowToken);

      return {
        id: newId(),
        campaignId,
        contactId: contact.id,
        phoneE164: contact.phoneE164,
        status: 'pending',
        payload,
        payloadHash: hash(JSON.stringify(payload)),
        flowToken,
        attemptCount: 0,
        nextAttemptAt: null,
        lastAttemptAt: null,
        createdAt,
        updatedAt: createdAt,
      } satisfies CampaignMessageRecord;
    });

    await this.database.replaceCampaignMessagesForCampaignInDatabase(campaignId, nextMessages);

    await this.database.write((draft) => {
      const item = draft.campaigns.find((record) => record.id === campaignId);
      if (!item) {
        throw new NotFoundException('Campanha não encontrada');
      }
      item.audienceSnapshot = selection.snapshot;
      item.updatedAt = nowIso();
    });

    await this.refreshCampaignSummary(campaignId);
  }

  buildTemplatePayload(
    campaign: CampaignRecord,
    template: TemplateCacheRecord | undefined,
    contact: ContactRecord,
    flowToken?: string | null,
  ): Record<string, unknown> {
    if (!template) {
      throw new Error('Template é obrigatório no piloto');
    }

    const bodyParameters = template.variableDescriptors
      .filter((descriptor) => descriptor.componentType === 'body')
      .sort((left, right) => left.placeholderIndex - right.placeholderIndex)
      .map((descriptor) => {
        const key = `${descriptor.componentType}:${descriptor.placeholderIndex}`;
        return {
          type: 'text',
          text: resolveParameterValue(campaign.parameterMapping[key], contact),
        };
      });

    const headerParameters = template.variableDescriptors
      .filter((descriptor) => descriptor.componentType === 'header')
      .sort((left, right) => left.placeholderIndex - right.placeholderIndex)
      .map((descriptor) => {
        const key = `${descriptor.componentType}:${descriptor.placeholderIndex}`;
        return {
          type: 'text',
          text: resolveParameterValue(campaign.parameterMapping[key], contact),
        };
      });

    const components: Record<string, unknown>[] = [];
    if (headerParameters.length > 0) {
      components.push({ type: 'header', parameters: headerParameters });
    }
    if (bodyParameters.length > 0) {
      components.push({ type: 'body', parameters: bodyParameters });
    }
    const flowButtonComponent = buildFlowButtonComponent(template, flowToken);
    if (flowButtonComponent) {
      components.push(flowButtonComponent);
    }

    return {
      messaging_product: 'whatsapp',
      to: contact.phoneE164.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: template.name,
        language: { code: template.languageCode },
        components,
      },
    };
  }

  async refreshCampaignSummary(campaignId: string) {
    const summary = await this.database.getCampaignMessageSummaryInDatabase(campaignId);
    await this.database.write((state) => {
      const campaign = state.campaigns.find((item) => item.id === campaignId);
      if (!campaign) {
        throw new NotFoundException('Campanha não encontrada');
      }

      campaign.summary = summary;

      const dispatchableLeft = summary.pending > 0;
      if (!dispatchableLeft && ['queued', 'sending'].includes(campaign.status)) {
        campaign.status = 'completed';
        campaign.finishedAt = nowIso();
      }

      campaign.updatedAt = nowIso();
    });
  }

  private async transitionStatus(
    id: string,
    nextStatus: CampaignRecord['status'],
    actor: UserSession,
    action: string,
  ) {
    await this.database.write((state) => {
      const campaign = state.campaigns.find((item) => item.id === id);
      if (!campaign) {
        throw new NotFoundException('Campanha não encontrada');
      }
      campaign.status = nextStatus;
      campaign.updatedAt = nowIso();
    });

    await this.audit.log({
      actorUserId: actor.id,
      action,
      entityType: 'campaign',
      entityId: id,
    });
  }

  private async loadListsByIds(listIds: string[]) {
    const uniqueIds = [...new Set(listIds.filter(Boolean))];
    if (uniqueIds.length === 0) {
      return new Map<string, { id: string; name: string; description?: string | null; sourceType: string; sourceFilePath?: string | null; createdAt: string; updatedAt: string }>();
    }

    const rows = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT id, name, description, source_type, source_file_path, created_at, updated_at
       FROM lists
       WHERE id = ANY($1::text[])`,
      [uniqueIds],
    );

    return new Map(
      rows.map((row) => [
        String(row.id),
        {
          id: String(row.id),
          name: String(row.name),
          description: normalizeOptionalText(row.description),
          sourceType: String(row.source_type),
          sourceFilePath: normalizeOptionalText(row.source_file_path),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
        },
      ]),
    );
  }

  private async loadContactsByIds(contactIds: string[]) {
    const uniqueIds = [...new Set(contactIds.filter(Boolean))];
    if (uniqueIds.length === 0) {
      return new Map<string, ContactRecord>();
    }

    const rows = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT
        id, external_ref, client_name, first_name, last_name, name, category, record_status,
        phone_raw, phone_e164, phone_hash, email, attributes_json, is_valid, validation_error,
        is_opted_out, opted_out_at, opt_out_source, imported_at, created_at, updated_at
       FROM contacts
       WHERE id = ANY($1::text[])`,
      [uniqueIds],
    );

    return new Map(rows.map((row) => [String(row.id), mapCampaignContactRow(row)]));
  }

  private async loadContactsForList(listId: string): Promise<ContactRecord[]> {
    const rows = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT
        c.id, c.external_ref, c.client_name, c.first_name, c.last_name, c.name, c.category, c.record_status,
        c.phone_raw, c.phone_e164, c.phone_hash, c.email, c.attributes_json, c.is_valid, c.validation_error,
        c.is_opted_out, c.opted_out_at, c.opt_out_source, c.imported_at, c.created_at, c.updated_at
       FROM list_members lm
       JOIN contacts c ON c.id = lm.contact_id
       WHERE lm.list_id = $1
       ORDER BY c.updated_at DESC`,
      [listId],
    );

    return rows.map(mapCampaignContactRow);
  }
}

const emptySummary = (): CampaignRecord['summary'] => ({
  total: 0,
  pending: 0,
  accepted: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  skipped: 0,
});

const emptyAudienceSnapshot = (): CampaignRecord['audienceSnapshot'] => ({
  listMembersTotal: 0,
  eligibleCount: 0,
  afterCategoryFilterCount: 0,
  afterResendFilterCount: 0,
  excludedByCategory: 0,
  afterUniqueWhatsAppFilterCount: 0,
  excludedByUniqueWhatsApp: 0,
  excludedByResendPolicy: 0,
  selectedCount: 0,
});

const normalizeAudienceConfig = (
  input?: Partial<CampaignAudienceConfig>,
): CampaignAudienceConfig => {
  const mode = input?.mode ?? 'all';
  const orderMode = input?.orderMode ?? 'field';

  return {
    mode,
    fixedCount:
      mode === 'fixed_count'
        ? Math.max(1, Number(input?.fixedCount ?? 1))
        : null,
    percentage:
      mode === 'percentage'
        ? Math.max(1, Math.min(100, Number(input?.percentage ?? 100)))
        : null,
    category: cleanNullableCampaignText(input?.category),
    orderMode,
    orderField: orderMode === 'field' ? (input?.orderField ?? 'importedAt') : null,
    orderDirection: input?.orderDirection === 'desc' ? 'desc' : 'asc',
    resendPolicy: input?.resendPolicy ?? 'all',
    uniqueWhatsAppOnly: Boolean(input?.uniqueWhatsAppOnly),
  };
};

const selectCampaignContacts = (
  campaign: CampaignRecord,
  contacts: ContactRecord[],
  campaignMessages: CampaignMessageRecord[],
): { selectedContacts: ContactRecord[]; snapshot: CampaignRecord['audienceSnapshot'] } => {
  const eligibleContacts = contacts.filter(isEligibleContactForCampaign);
  const afterCategoryFilter = eligibleContacts.filter((contact) =>
    passesCategoryFilter(contact, campaign.audience.category),
  );
  const afterResendFilter = afterCategoryFilter.filter((contact) =>
    passesResendPolicy(contact.id, campaign.id, campaign.audience.resendPolicy, campaignMessages),
  );
  const afterUniqueWhatsAppFilter = campaign.audience.uniqueWhatsAppOnly
    ? afterResendFilter.filter((contact) =>
        passesUniqueWhatsAppPolicy(contact.id, campaign.id, campaignMessages),
      )
    : afterResendFilter;
  const orderedContacts = orderCampaignContacts(afterUniqueWhatsAppFilter, campaign.audience);
  const selectedContacts = limitCampaignContacts(orderedContacts, campaign.audience);

  return {
    selectedContacts,
    snapshot: {
      listMembersTotal: contacts.length,
      eligibleCount: eligibleContacts.length,
      afterCategoryFilterCount: afterCategoryFilter.length,
      afterResendFilterCount: afterResendFilter.length,
      excludedByCategory: eligibleContacts.length - afterCategoryFilter.length,
      afterUniqueWhatsAppFilterCount: afterUniqueWhatsAppFilter.length,
      excludedByUniqueWhatsApp: afterResendFilter.length - afterUniqueWhatsAppFilter.length,
      excludedByResendPolicy: afterCategoryFilter.length - afterResendFilter.length,
      selectedCount: selectedContacts.length,
    },
  };
};

const isEligibleContactForCampaign = (contact: ContactRecord): boolean =>
  contact.isValid && !contact.isOptedOut && contact.recordStatus === 'active';

const passesCategoryFilter = (contact: ContactRecord, category?: string | null): boolean => {
  const normalizedCategory = cleanNullableCampaignText(category);
  if (!normalizedCategory) {
    return true;
  }

  return cleanNullableCampaignText(contact.category) === normalizedCategory;
};

const passesResendPolicy = (
  contactId: string,
  campaignId: string,
  resendPolicy: CampaignAudienceConfig['resendPolicy'],
  campaignMessages: CampaignMessageRecord[],
): boolean => {
  if (resendPolicy === 'all') {
    return true;
  }

  const previousMessages = campaignMessages.filter(
    (message) => message.campaignId !== campaignId && message.contactId === contactId,
  );

  if (resendPolicy === 'not_delivered') {
    return !previousMessages.some((message) => ['delivered', 'read'].includes(message.status));
  }

  if (resendPolicy === 'not_read') {
    return !previousMessages.some((message) => message.status === 'read');
  }

  return true;
};

const passesUniqueWhatsAppPolicy = (
  contactId: string,
  campaignId: string,
  campaignMessages: CampaignMessageRecord[],
): boolean =>
  !campaignMessages.some(
    (message) =>
      message.campaignId !== campaignId &&
      message.contactId === contactId &&
      !['cancelled', 'skipped'].includes(message.status),
  );

const orderCampaignContacts = (
  contacts: ContactRecord[],
  audience: CampaignAudienceConfig,
): ContactRecord[] => {
  const ordered = [...contacts];
  if (audience.orderMode === 'random') {
    for (let index = ordered.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [ordered[index], ordered[swapIndex]] = [ordered[swapIndex], ordered[index]];
    }
    return ordered;
  }

  const direction = audience.orderDirection === 'desc' ? -1 : 1;
  const field = audience.orderField ?? 'importedAt';

  return ordered.sort((left, right) => {
    const comparison = compareContactField(left, right, field);
    if (comparison !== 0) {
      return comparison * direction;
    }

    return left.id.localeCompare(right.id) * direction;
  });
};

const compareContactField = (
  left: ContactRecord,
  right: ContactRecord,
  field: CampaignAudienceOrderField,
): number => {
  const leftValue = getContactFieldValue(left, field);
  const rightValue = getContactFieldValue(right, field);

  return leftValue.localeCompare(rightValue, 'pt-BR', {
    sensitivity: 'base',
    numeric: true,
  });
};

const getContactFieldValue = (
  contact: ContactRecord,
  field: CampaignAudienceOrderField,
): string => {
  switch (field) {
    case 'clientName':
      return String(contact.clientName ?? '');
    case 'firstName':
      return String(contact.firstName ?? '');
    case 'lastName':
      return String(contact.lastName ?? '');
    case 'name':
      return String(contact.name ?? '');
    case 'category':
      return String(contact.category ?? '');
    case 'phoneE164':
      return String(contact.phoneE164 ?? '');
    case 'createdAt':
      return String(contact.createdAt ?? '');
    case 'importedAt':
    default:
      return String(contact.importedAt ?? contact.createdAt ?? '');
  }
};

const limitCampaignContacts = (
  contacts: ContactRecord[],
  audience: CampaignAudienceConfig,
): ContactRecord[] => {
  if (audience.mode === 'fixed_count') {
    return contacts.slice(0, Math.max(0, Number(audience.fixedCount ?? 0)));
  }

  if (audience.mode === 'percentage') {
    const percentage = Math.max(1, Math.min(100, Number(audience.percentage ?? 100)));
    const limit = contacts.length
      ? Math.max(1, Math.ceil((contacts.length * percentage) / 100))
      : 0;
    return contacts.slice(0, limit);
  }

  return contacts;
};

const findFlowForTemplate = (
  template: TemplateCacheRecord,
  flows: FlowCacheRecord[],
): FlowCacheRecord | undefined => {
  const flowId = template.flowButtonMeta?.flow_id;
  return flowId
    ? flows.find((flow) => String(flow.metaFlowId) === String(flowId))
    : undefined;
};

const buildFlowButtonComponent = (
  template: TemplateCacheRecord,
  flowToken?: string | null,
): Record<string, unknown> | null => {
  if (!template.hasFlowButton || !flowToken) {
    return null;
  }

  const flowButtonMeta = template.flowButtonMeta ?? {};
  const buttonIndex = Number(flowButtonMeta.buttonIndex ?? 0);

  return {
    type: 'button',
    sub_type: 'flow',
    index: String(Number.isFinite(buttonIndex) ? buttonIndex : 0),
    parameters: [
      {
        type: 'action',
        action: {
          flow_token: flowToken,
        },
      },
    ],
  };
};

const mapCampaignContactRow = (row: Record<string, unknown>): ContactRecord => ({
  id: String(row.id),
  externalRef: normalizeOptionalText(row.external_ref),
  clientName: normalizeOptionalText(row.client_name),
  firstName: String(row.first_name ?? 'Sem nome'),
  lastName: normalizeOptionalText(row.last_name),
  name: String(row.name ?? 'Sem nome'),
  category: normalizeOptionalText(row.category),
  recordStatus: String(row.record_status) === 'inactive' ? 'inactive' : 'active',
  phoneRaw: String(row.phone_raw ?? ''),
  phoneE164: String(row.phone_e164 ?? ''),
  phoneHash: String(row.phone_hash ?? ''),
  email: normalizeOptionalText(row.email),
  attributes: parseCampaignAttributes(row.attributes_json),
  isValid: Number(row.is_valid ?? 0) === 1,
  validationError: normalizeOptionalText(row.validation_error),
  isOptedOut: Number(row.is_opted_out ?? 0) === 1,
  optedOutAt: normalizeOptionalText(row.opted_out_at),
  optOutSource: normalizeOptionalText(row.opt_out_source),
  importedAt: normalizeOptionalText(row.imported_at),
  createdAt: String(row.created_at ?? nowIso()),
  updatedAt: String(row.updated_at ?? nowIso()),
});

const parseCampaignAttributes = (value: unknown): Record<string, string> => {
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed ?? {}).flatMap(([key, rawValue]) => {
        if (rawValue === undefined || rawValue === null) {
          return [];
        }
        return [[key, String(rawValue)]];
      }),
    );
  } catch {
    return {};
  }
};

const normalizeOptionalText = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
};

const cleanNullableCampaignText = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }

  const text = String(value).trim();
  return text ? text : null;
};
