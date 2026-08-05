import { Injectable, Logger } from '@nestjs/common';
import { getEnv } from '../common/env';
import { DatabaseService } from '../database/database.service';
import { hash, newId, normalizeKeyword, nowIso } from '../database/helpers';
import { CampaignMessageRecord, ContactRecord, FlowCacheRecord, FlowResponseRecord } from '../database/types';
import { CampaignsService } from '../campaigns/campaigns.service';
import { TransactionalCallbackService } from '../transactional/transactional-callback.service';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly campaignsService: CampaignsService,
    private readonly transactionalCallbacks: TransactionalCallbackService,
  ) {}

  async process(payload: Record<string, unknown>) {
    const changes = extractChanges(payload);

    for (const change of changes) {
      for (const status of change.statuses) {
        await this.handleStatus(status, payload);
      }

      for (const message of change.messages) {
        await this.handleInbound(message, payload, change.contacts, change.phoneNumberId);
      }
    }

    return { received: true };
  }

  private async handleStatus(
    status: Record<string, unknown>,
    payload: Record<string, unknown>,
  ) {
    const providerMessageId = String(status.id ?? '');
    const nextStatus = String(status.status ?? '');
    const timestamp = String(status.timestamp ?? Math.floor(Date.now() / 1000));
    const dedupeKey = hash(`${providerMessageId}:${nextStatus}:${timestamp}`);

    if (await this.database.hasMessageEventInDatabase(dedupeKey)) {
      return;
    }

    const message = await this.database.findCampaignMessageByProviderMessageIdInDatabase(providerMessageId);
    const receivedAt = nowIso();
    const occurredAt = new Date(Number(timestamp) * 1000).toISOString();

    const persisted = await this.database.saveMessageEventInDatabase({
      id: newId(),
      campaignMessageId: message?.id ?? null,
      providerMessageId,
      eventType: 'meta.status',
      status: nextStatus,
      payload,
      occurredAt,
      receivedAt,
      dedupeKey,
    });

    // Precificação da Meta (WABA-23): o objeto `pricing` chega junto ao status
    // ('sent'/'delivered'...). Persistimos de forma idempotente (UPDATE por
    // provider_message_id) sem depender de o campaign_message já existir localmente
    // e sem tocar na guarda de status abaixo. Ausência de pricing é no-op.
    if (persisted) {
      const pricing = extractPricing(status);
      if (pricing) {
        // Robustez (Débora): pricing é dado secundário — uma falha ao gravá-lo
        // não pode derrubar o processamento do status. Loga e segue.
        try {
          await this.database.setCampaignMessagePricing(providerMessageId, pricing);
        } catch (error) {
          this.logger.warn(
            `Falha ao gravar pricing de ${providerMessageId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    if (!persisted || !message) {
      return;
    }

    const nextMessage = {
      ...message,
      status: resolveStatus(message.status, mapWebhookStatus(nextStatus)),
      updatedAt: receivedAt,
    };
    if (nextStatus === 'sent') nextMessage.sentAt = receivedAt;
    if (nextStatus === 'delivered') nextMessage.deliveredAt = receivedAt;
    if (nextStatus === 'read') nextMessage.readAt = receivedAt;
    if (nextStatus === 'failed') {
      nextMessage.failedAt = receivedAt;
      const errors = Array.isArray(status.errors) ? status.errors[0] : undefined;
      nextMessage.providerErrorCode = errors ? String((errors as Record<string, unknown>).code ?? '') : null;
      nextMessage.providerErrorTitle = errors
        ? String((errors as Record<string, unknown>).title ?? 'Webhook failed')
        : 'Webhook failed';
      nextMessage.providerErrorMessage = errors ? JSON.stringify(errors) : 'Webhook failed';
    }

    await this.database.saveCampaignMessageInDatabase(nextMessage);

    // Callback de saída para mensagens transacionais (OTP/token): best-effort,
    // fora do caminho crítico do webhook (void + catch).
    const dispatch = await this.database.findTransactionalDispatchByCampaignMessageId(message.id);
    if (dispatch?.callbackUrl) {
      const error =
        nextStatus === 'failed'
          ? {
              code: nextMessage.providerErrorCode ?? null,
              title: nextMessage.providerErrorTitle ?? null,
            }
          : undefined;
      void this.transactionalCallbacks
        .notify(dispatch, {
          messageId: message.id,
          idempotencyKey: dispatch.idempotencyKey ?? null,
          to: message.phoneE164,
          status: nextStatus,
          providerMessageId,
          occurredAt,
          ...(error ? { error } : {}),
        })
        .catch(() => undefined);
    }

    await this.campaignsService.refreshCampaignSummary(message.campaignId);
  }

  private async handleInbound(
    message: Record<string, unknown>,
    payload: Record<string, unknown>,
    contacts: Array<Record<string, unknown>>,
    receivingPhoneNumberId: string | null,
  ) {
    const waId = String(message.from ?? contacts[0]?.wa_id ?? '');
    if (!waId) {
      return;
    }

    const state = await this.database.readMetaSnapshot();
    // Escopo por tenant: o telefone pode existir em mais de um tenant (unicidade
    // por (client_id, phone_hash)). Resolvemos o tenant pela integração que
    // recebeu a mensagem (phone_number_id) para não marcar opt-out no contato
    // errado. Integração desconhecida => pool compartilhado (client_id nulo).
    const tenantClientId =
      (receivingPhoneNumberId
        ? state.integrations.find(
            (integration) => integration.phoneNumberId === receivingPhoneNumberId,
          )?.clientId
        : null) ?? null;
    const [contactRow] = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT id, phone_hash
       FROM contacts
       WHERE phone_hash = $1
         AND COALESCE(client_id, '') = COALESCE($2, '')
       LIMIT 1`,
      [hash(waId), tenantClientId],
    );
    const contact = contactRow
      ? {
          id: String(contactRow.id),
          phoneHash: String(contactRow.phone_hash),
        }
      : null;
    const providerMessageId = String(message.id ?? '');
    const contextMessageId = normalizeOptionalValue(asRecord(message.context)?.id);
    const dedupeKey = hash(`${providerMessageId || newId()}:inbound`);

    if (await this.database.hasMessageEventInDatabase(dedupeKey)) {
      return;
    }

    const interactive = asRecord(message.interactive);
    const isFlowReply =
      String(message.type ?? '') === 'interactive' &&
      String(interactive?.type ?? '') === 'nfm_reply';
    const flowReply = isFlowReply ? extractFlowReply(interactive) : null;
    const relatedMessage = await this.findRelatedCampaignMessage(message, flowReply);
    const relatedFlow = this.findRelatedFlow(state.flows, state, relatedMessage, flowReply);
    const receivedAt = nowIso();
    const persisted = await this.database.saveMessageEventInDatabase({
      id: newId(),
      campaignMessageId: relatedMessage?.id ?? null,
      providerMessageId,
      eventType: isFlowReply ? 'meta.flow_reply' : 'meta.inbound',
      status: null,
      payload,
      occurredAt: receivedAt,
      receivedAt,
      dedupeKey,
    });

    if (!persisted) {
      return;
    }

    if (flowReply) {
      await this.database.saveFlowResponseInDatabase({
        id: newId(),
        integrationId: relatedMessage?.campaignId
          ? (state.campaigns.find((campaign) => campaign.id === relatedMessage.campaignId)?.integrationId ??
            state.integrations[0]?.id ??
            '')
          : (state.integrations[0]?.id ?? ''),
        campaignId: relatedMessage?.campaignId ?? null,
        campaignMessageId: relatedMessage?.id ?? null,
        contactId: contact?.id ?? null,
        templateCacheId:
          relatedMessage?.campaignId
            ? (state.campaigns.find((campaign) => campaign.id === relatedMessage.campaignId)?.templateCacheId ??
              null)
            : null,
        flowCacheId:
          relatedMessage?.campaignId
            ? (state.campaigns.find((campaign) => campaign.id === relatedMessage.campaignId)?.flowCacheId ??
              relatedFlow?.id ??
              null)
            : (relatedFlow?.id ?? null),
        metaFlowId: relatedFlow?.metaFlowId ?? null,
        flowToken: flowReply.flowToken ?? relatedMessage?.flowToken ?? null,
        providerMessageId,
        providerContextMessageId: contextMessageId ?? flowReply.contextMessageId ?? null,
        waId,
        responsePayload: flowReply.responsePayload,
        responsePayloadRaw: flowReply.responsePayloadRaw,
        rawMessage: message,
        rawWebhook: payload,
        completedAt: receivedAt,
        createdAt: receivedAt,
        updatedAt: receivedAt,
      });
    }

    if (!contact) {
      return;
    }

    const body = String(((message.text as Record<string, unknown>)?.body ?? '') as string);
    const normalized = normalizeKeyword(body);
    if (body && getEnv().optOutKeywords.includes(normalized)) {
      await this.markOptOut(contact, normalized);
    }
  }

  private async markOptOut(contact: Pick<ContactRecord, 'id'>, keyword: string) {
    const timestamp = nowIso();
    await this.database.postgresQuery(
      `UPDATE contacts
       SET is_opted_out = true, opted_out_at = $1, opt_out_source = 'inbound_keyword', updated_at = $2
       WHERE id = $3`,
      [timestamp, timestamp, contact.id],
    );

    await this.database.saveOptOutInDatabase({
      id: newId(),
      contactId: contact.id,
      source: 'inbound_keyword',
      keyword,
      createdAt: timestamp,
    });
  }

  private async findRelatedCampaignMessage(
    message: Record<string, unknown>,
    flowReply: ExtractedFlowReply | null,
  ): Promise<CampaignMessageRecord | undefined> {
    const contextMessageId = String(
      (asRecord(message.context)?.id ?? flowReply?.contextMessageId ?? '') as string,
    );
    if (contextMessageId) {
      const byContext = await this.database.findCampaignMessageByProviderMessageIdInDatabase(contextMessageId);
      if (byContext) {
        return byContext;
      }
    }

    if (flowReply?.flowToken) {
      return (await this.database.findCampaignMessageByFlowTokenInDatabase(flowReply.flowToken)) ?? undefined;
    }

    return undefined;
  }

  private findRelatedFlow(
    flows: FlowCacheRecord[],
    state: { campaigns: Array<{ id: string; flowCacheId?: string | null }> },
    relatedMessage: CampaignMessageRecord | undefined,
    flowReply: ExtractedFlowReply | null,
  ): FlowCacheRecord | undefined {
    const campaign = relatedMessage
      ? state.campaigns.find((item) => item.id === relatedMessage.campaignId)
      : undefined;
    if (campaign?.flowCacheId) {
      const byCampaign = flows.find((flow) => flow.id === campaign.flowCacheId);
      if (byCampaign) {
        return byCampaign;
      }
    }

    const responseFlowId = flowReply?.metaFlowId;
    if (responseFlowId) {
      return flows.find((flow) => String(flow.metaFlowId) === String(responseFlowId));
    }

    return undefined;
  }
}

type MessageStatus = CampaignMessageRecord['status'];

// Escala total de progresso do ciclo de vida da mensagem. Ranks maiores só
// avançam, nunca regridem (guarda de monotonia): eventos de webhook podem
// chegar fora de ordem (ex.: 'delivered' atrasado depois de 'read'). Status
// fora da escala (skipped/cancelled) têm rank indefinido e preservam o atual.
const STATUS_RANK: Partial<Record<MessageStatus, number>> = {
  pending: 0,
  accepted: 1,
  sent: 2,
  failed: 3,
  delivered: 4,
  read: 5,
};

const resolveStatus = (current: MessageStatus, next: MessageStatus): MessageStatus => {
  const currentRank = STATUS_RANK[current];
  const nextRank = STATUS_RANK[next];
  if (currentRank === undefined || nextRank === undefined) {
    return current;
  }
  return nextRank > currentRank ? next : current;
};

const mapWebhookStatus = (
  status: string,
): 'accepted' | 'sent' | 'delivered' | 'read' | 'failed' => {
  switch (status) {
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'failed':
      return 'failed';
    default:
      return 'accepted';
  }
};

const extractChanges = (
  payload: Record<string, unknown>,
): Array<{
  statuses: Array<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  contacts: Array<Record<string, unknown>>;
  phoneNumberId: string | null;
}> => {
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  const changes = entries.flatMap((entry) =>
    Array.isArray((entry as Record<string, unknown>).changes)
      ? ((entry as Record<string, unknown>).changes as Record<string, unknown>[])
      : [],
  );

  return changes.map((change) => {
    const value = ((change as Record<string, unknown>).value ?? {}) as Record<string, unknown>;
    const metadata = (value.metadata ?? {}) as Record<string, unknown>;
    return {
      statuses: Array.isArray(value.statuses) ? (value.statuses as Array<Record<string, unknown>>) : [],
      messages: Array.isArray(value.messages) ? (value.messages as Array<Record<string, unknown>>) : [],
      contacts: Array.isArray(value.contacts) ? (value.contacts as Array<Record<string, unknown>>) : [],
      phoneNumberId: metadata.phone_number_id ? String(metadata.phone_number_id) : null,
    };
  });
};

interface ExtractedFlowReply {
  responsePayload: Record<string, unknown>;
  responsePayloadRaw?: string | null;
  flowToken?: string | null;
  metaFlowId?: string | null;
  contextMessageId?: string | null;
}

const extractFlowReply = (
  interactive: Record<string, unknown> | null,
): ExtractedFlowReply | null => {
  const nfmReply = asRecord(interactive?.nfm_reply);
  if (!nfmReply) {
    return null;
  }

  const rawResponse = nfmReply.response_json;
  const responsePayload = parseResponsePayload(rawResponse);
  const flowToken = normalizeOptionalValue(
    responsePayload.flow_token ?? responsePayload.flowToken ?? nfmReply.flow_token,
  );
  const metaFlowId = normalizeOptionalValue(
    responsePayload.flow_id ?? responsePayload.flowId ?? nfmReply.flow_id,
  );

  return {
    responsePayload,
    responsePayloadRaw: typeof rawResponse === 'string' ? rawResponse : null,
    flowToken,
    metaFlowId,
    contextMessageId: normalizeOptionalValue(nfmReply.context_id),
  };
};

const parseResponsePayload = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return asRecord(parsed) ?? { raw: parsed };
    } catch {
      return { raw: value };
    }
  }

  return asRecord(value) ?? {};
};

const normalizeOptionalValue = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Extrai o bloco `pricing` do status do webhook Meta
 * (`{ type, billable, category, pricing_model }`). Retorna `null` quando não há
 * pricing ou nenhum campo útil, para o chamador pular o UPDATE.
 */
const extractPricing = (
  status: Record<string, unknown>,
): { category?: string | null; billable?: boolean | null; model?: string | null } | null => {
  const pricing = asRecord(status.pricing);
  if (!pricing) {
    return null;
  }
  const category = normalizeOptionalValue(pricing.category);
  const model = normalizeOptionalValue(pricing.pricing_model);
  const billable = typeof pricing.billable === 'boolean' ? pricing.billable : null;
  if (category === null && model === null && billable === null) {
    return null;
  }
  return { category, billable, model };
};

const upsertFlowResponse = (
  responses: FlowResponseRecord[],
  nextResponse: FlowResponseRecord,
) => {
  const existing = responses.find(
    (item) =>
      item.providerMessageId === nextResponse.providerMessageId ||
      (nextResponse.flowToken && item.flowToken === nextResponse.flowToken),
  );
  if (!existing) {
    responses.push(nextResponse);
    return;
  }

  existing.integrationId = nextResponse.integrationId;
  existing.campaignId = nextResponse.campaignId;
  existing.campaignMessageId = nextResponse.campaignMessageId;
  existing.contactId = nextResponse.contactId;
  existing.templateCacheId = nextResponse.templateCacheId;
  existing.flowCacheId = nextResponse.flowCacheId;
  existing.metaFlowId = nextResponse.metaFlowId;
  existing.flowToken = nextResponse.flowToken;
  existing.providerContextMessageId = nextResponse.providerContextMessageId;
  existing.waId = nextResponse.waId;
  existing.responsePayload = nextResponse.responsePayload;
  existing.responsePayloadRaw = nextResponse.responsePayloadRaw;
  existing.rawMessage = nextResponse.rawMessage;
  existing.rawWebhook = nextResponse.rawWebhook;
  existing.completedAt = nextResponse.completedAt;
  existing.updatedAt = nowIso();
};
