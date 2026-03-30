import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { DatabaseService } from '../database/database.service';
import { hash, newId, nowIso, resolveParameterValue } from '../database/helpers';
import {
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
}

@Injectable()
export class CampaignsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const state = await this.database.read();
    return state.campaigns
      .map((campaign) => ({
        ...campaign,
        template: state.templates.find((template) => template.id === campaign.templateCacheId) ?? null,
        list: state.lists.find((list) => list.id === campaign.listId) ?? null,
      }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getCampaign(id: string) {
    const state = await this.database.read();
    const campaign = state.campaigns.find((item) => item.id === id);
    if (!campaign) {
      throw new NotFoundException('Campanha não encontrada');
    }

    return {
      ...campaign,
      messages: state.campaignMessages.filter((message) => message.campaignId === id),
    };
  }

  async create(input: CreateCampaignInput, actor: UserSession): Promise<CampaignRecord> {
    const state = await this.database.read();
    const template = input.templateCacheId
      ? state.templates.find((item) => item.id === input.templateCacheId)
      : undefined;
    const inferredFlow = template?.hasFlowButton
      ? findFlowForTemplate(template, state.flows)
      : undefined;

    if (!state.integrations.some((item) => item.id === input.integrationId)) {
      throw new NotFoundException('Integração não encontrada');
    }
    if (!state.lists.some((item) => item.id === input.listId)) {
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
      sendRateMps: Math.max(1, Math.min(80, Number(input.sendRateMps ?? 20))),
      status: 'draft',
      summary: {
        total: 0,
        pending: 0,
        accepted: 0,
        sent: 0,
        delivered: 0,
        read: 0,
        failed: 0,
        skipped: 0,
      },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    await this.database.write((draft) => {
      draft.campaigns.push(campaign);
    });

    await this.audit.log({
      actorUserId: actor.id,
      action: 'campaign.created',
      entityType: 'campaign',
      entityId: campaign.id,
      metadata: {
        listId: campaign.listId,
        templateCacheId: campaign.templateCacheId,
      },
    });

    return campaign;
  }

  async start(id: string, actor: UserSession) {
    const state = await this.database.read();
    const campaign = state.campaigns.find((item) => item.id === id);
    if (!campaign) {
      throw new NotFoundException('Campanha não encontrada');
    }

    if (campaign.status === 'draft') {
      await this.prepareMessages(campaign.id);
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
    await this.transitionStatus(id, 'queued', actor, 'campaign.resumed');
    return this.getCampaign(id);
  }

  async retryFailed(id: string, actor: UserSession) {
    await this.database.write((state) => {
      for (const message of state.campaignMessages.filter(
        (item) => item.campaignId === id && item.status === 'failed',
      )) {
        message.status = 'pending';
        message.nextAttemptAt = nowIso();
        message.updatedAt = nowIso();
      }
    });

    await this.audit.log({
      actorUserId: actor.id,
      action: 'campaign.retry_failed',
      entityType: 'campaign',
      entityId: id,
    });

    return this.getCampaign(id);
  }

  async prepareMessages(campaignId: string) {
    const state = await this.database.read();
    const campaign = state.campaigns.find((item) => item.id === campaignId);
    if (!campaign) {
      throw new NotFoundException('Campanha não encontrada');
    }

    const template = campaign.templateCacheId
      ? state.templates.find((item) => item.id === campaign.templateCacheId)
      : undefined;
    const listMembers = state.listMembers.filter((member) => member.listId === campaign.listId);
    const contacts = listMembers
      .map((member) => state.contacts.find((contact) => contact.id === member.contactId))
      .filter(Boolean) as ContactRecord[];

    await this.database.write((draft) => {
      for (const contact of contacts) {
        const exists = draft.campaignMessages.some(
          (item) => item.campaignId === campaignId && item.contactId === contact.id,
        );
        if (exists) {
          continue;
        }

        const baseMessage: CampaignMessageRecord = {
          id: newId(),
          campaignId,
          contactId: contact.id,
          phoneE164: contact.phoneE164,
          status: 'pending',
          payload: {},
          payloadHash: '',
          flowToken: null,
          attemptCount: 0,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };

        if (!contact.isValid) {
          baseMessage.status = 'skipped';
          baseMessage.skipReason = contact.validationError ?? 'Contato inválido';
        } else if (contact.recordStatus !== 'active') {
          baseMessage.status = 'skipped';
          baseMessage.skipReason = 'Contato inativo';
        } else if (contact.isOptedOut) {
          baseMessage.status = 'skipped';
          baseMessage.skipReason = 'Contato com opt-out';
        } else {
          const flowToken = template?.hasFlowButton
            ? `cmp_${campaign.id}_ctt_${contact.id}`
            : null;
          const payload = this.buildTemplatePayload(campaign, template, contact, flowToken);
          baseMessage.payload = payload;
          baseMessage.payloadHash = hash(JSON.stringify(payload));
          baseMessage.flowToken = flowToken;
        }

        draft.campaignMessages.push(baseMessage);
      }
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
    await this.database.write((state) => {
      const campaign = state.campaigns.find((item) => item.id === campaignId);
      if (!campaign) {
        throw new NotFoundException('Campanha não encontrada');
      }

      const messages = state.campaignMessages.filter((item) => item.campaignId === campaignId);
      campaign.summary = {
        total: messages.length,
        pending: messages.filter((item) => item.status === 'pending').length,
        accepted: messages.filter((item) => item.status === 'accepted').length,
        sent: messages.filter((item) => item.status === 'sent').length,
        delivered: messages.filter((item) => item.status === 'delivered').length,
        read: messages.filter((item) => item.status === 'read').length,
        failed: messages.filter((item) => item.status === 'failed').length,
        skipped: messages.filter((item) => item.status === 'skipped').length,
      };

      const dispatchableLeft = messages.some((item) => item.status === 'pending');
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
}

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
