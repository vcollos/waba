import { Injectable } from '@nestjs/common';
import { getEnv } from '../common/env';
import { DatabaseService } from '../database/database.service';
import { hash, newId, normalizeKeyword, nowIso } from '../database/helpers';
import { CampaignMessageRecord, ContactRecord, FlowCacheRecord, FlowResponseRecord } from '../database/types';
import { CampaignsService } from '../campaigns/campaigns.service';

@Injectable()
export class WebhooksService {
  constructor(
    private readonly database: DatabaseService,
    private readonly campaignsService: CampaignsService,
  ) {}

  async process(payload: Record<string, unknown>) {
    const changes = extractChanges(payload);

    for (const change of changes) {
      for (const status of change.statuses) {
        await this.handleStatus(status, payload);
      }

      for (const message of change.messages) {
        await this.handleInbound(message, payload, change.contacts);
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

    const state = await this.database.readMetaSnapshot();
    if (state.messageEvents.some((event) => event.dedupeKey === dedupeKey)) {
      return;
    }

    const message = state.campaignMessages.find(
      (item) => item.providerMessageId === providerMessageId,
    );

    await this.database.write((draft) => {
      draft.messageEvents.push({
        id: newId(),
        campaignMessageId: message?.id ?? null,
        providerMessageId,
        eventType: 'meta.status',
        status: nextStatus,
        payload,
        occurredAt: new Date(Number(timestamp) * 1000).toISOString(),
        receivedAt: nowIso(),
        dedupeKey,
      });

      if (message) {
        const item = draft.campaignMessages.find((record) => record.id === message.id);
        if (!item) {
          return;
        }

        item.status = mapWebhookStatus(nextStatus);
        item.updatedAt = nowIso();
        if (nextStatus === 'sent') item.sentAt = nowIso();
        if (nextStatus === 'delivered') item.deliveredAt = nowIso();
        if (nextStatus === 'read') item.readAt = nowIso();
        if (nextStatus === 'failed') {
          item.failedAt = nowIso();
          const errors = Array.isArray(status.errors) ? status.errors[0] : undefined;
          item.providerErrorCode = errors ? String((errors as Record<string, unknown>).code ?? '') : null;
          item.providerErrorTitle = errors
            ? String((errors as Record<string, unknown>).title ?? 'Webhook failed')
            : 'Webhook failed';
          item.providerErrorMessage = errors ? JSON.stringify(errors) : 'Webhook failed';
        }
      }
    });

    if (message) {
      await this.campaignsService.refreshCampaignSummary(message.campaignId);
    }
  }

  private async handleInbound(
    message: Record<string, unknown>,
    payload: Record<string, unknown>,
    contacts: Array<Record<string, unknown>>,
  ) {
    const waId = String(message.from ?? contacts[0]?.wa_id ?? '');
    if (!waId) {
      return;
    }

    const state = await this.database.readMetaSnapshot();
    const contact = await this.database.execute((database) => {
      const row = database
        .prepare(
          `SELECT id, phone_hash
           FROM contacts
           WHERE phone_hash = ?
           LIMIT 1`,
        )
        .get(hash(waId)) as Record<string, unknown> | undefined;

      return row
        ? {
            id: String(row.id),
            phoneHash: String(row.phone_hash),
          }
        : null;
    });
    const providerMessageId = String(message.id ?? '');
    const contextMessageId = normalizeOptionalValue(asRecord(message.context)?.id);
    const dedupeKey = hash(`${providerMessageId || newId()}:inbound`);

    if (state.messageEvents.some((event) => event.dedupeKey === dedupeKey)) {
      return;
    }

    const interactive = asRecord(message.interactive);
    const isFlowReply =
      String(message.type ?? '') === 'interactive' &&
      String(interactive?.type ?? '') === 'nfm_reply';
    const flowReply = isFlowReply ? extractFlowReply(interactive) : null;
    const relatedMessage = this.findRelatedCampaignMessage(state.campaignMessages, message, flowReply);
    const relatedFlow = this.findRelatedFlow(state.flows, state, relatedMessage, flowReply);

    await this.database.write((draft) => {
      draft.messageEvents.push({
        id: newId(),
        campaignMessageId: relatedMessage?.id ?? null,
        providerMessageId,
        eventType: isFlowReply ? 'meta.flow_reply' : 'meta.inbound',
        status: null,
        payload,
        occurredAt: nowIso(),
        receivedAt: nowIso(),
        dedupeKey,
      });

      if (flowReply) {
        upsertFlowResponse(draft.flowResponses, {
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
          completedAt: nowIso(),
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
      }
    });

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
    await this.database.transaction((database) => {
      database
        .prepare(
          `UPDATE contacts
           SET is_opted_out = 1, opted_out_at = ?, opt_out_source = 'inbound_keyword', updated_at = ?
           WHERE id = ?`,
        )
        .run(timestamp, timestamp, contact.id);
    });

    await this.database.write((state) => {
      state.optOuts.push({
        id: newId(),
        contactId: contact.id,
        source: 'inbound_keyword',
        keyword,
        createdAt: timestamp,
      });
    });
  }

  private findRelatedCampaignMessage(
    messages: CampaignMessageRecord[],
    message: Record<string, unknown>,
    flowReply: ExtractedFlowReply | null,
  ): CampaignMessageRecord | undefined {
    const contextMessageId = String(
      (asRecord(message.context)?.id ?? flowReply?.contextMessageId ?? '') as string,
    );
    if (contextMessageId) {
      const byContext = messages.find((item) => item.providerMessageId === contextMessageId);
      if (byContext) {
        return byContext;
      }
    }

    if (flowReply?.flowToken) {
      return messages.find((item) => item.flowToken === flowReply.flowToken);
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
}> => {
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  const changes = entries.flatMap((entry) =>
    Array.isArray((entry as Record<string, unknown>).changes)
      ? ((entry as Record<string, unknown>).changes as Record<string, unknown>[])
      : [],
  );

  return changes.map((change) => {
    const value = ((change as Record<string, unknown>).value ?? {}) as Record<string, unknown>;
    return {
      statuses: Array.isArray(value.statuses) ? (value.statuses as Array<Record<string, unknown>>) : [],
      messages: Array.isArray(value.messages) ? (value.messages as Array<Record<string, unknown>>) : [],
      contacts: Array.isArray(value.contacts) ? (value.contacts as Array<Record<string, unknown>>) : [],
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
