import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { newId, nowIso } from '../database/helpers';
import { CampaignMessageRecord, CampaignRecord, IntegrationRecord } from '../database/types';
import { IntegrationsService } from '../integrations/integrations.service';
import { MetaApiError, MetaGraphService } from '../integrations/meta-graph.service';
import { CampaignsService } from './campaigns.service';

@Injectable()
export class DispatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DispatchService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(IntegrationsService)
    private readonly integrationsService: IntegrationsService,
    @Inject(MetaGraphService)
    private readonly metaGraph: MetaGraphService,
    @Inject(CampaignsService)
    private readonly campaignsService: CampaignsService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick();
    }, 1000);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async tick() {
    if (this.running) {
      return;
    }
    this.running = true;

    try {
      const state = await this.database.read();
      const activeCampaigns = state.campaigns.filter((campaign) =>
        ['queued', 'sending'].includes(campaign.status),
      );

      for (const campaign of activeCampaigns) {
        await this.dispatchCampaign(campaign, state.integrations);
      }
    } catch (error) {
      this.logger.error('Dispatch tick failed', error instanceof Error ? error.stack : String(error));
    } finally {
      this.running = false;
    }
  }

  private async dispatchCampaign(
    campaign: CampaignRecord,
    integrations: IntegrationRecord[],
  ): Promise<void> {
    const integration = integrations.find((item) => item.id === campaign.integrationId);
    if (!integration) {
      return;
    }

    const state = await this.database.read();
    const candidates = state.campaignMessages
      .filter((message) => this.isDispatchable(message, campaign.id))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, campaign.sendRateMps);

    if (candidates.length === 0) {
      await this.campaignsService.refreshCampaignSummary(campaign.id);
      return;
    }

    await this.database.write((draft) => {
      const item = draft.campaigns.find((record) => record.id === campaign.id);
      if (item) {
        item.status = 'sending';
        item.updatedAt = nowIso();
      }
    });

    for (const message of candidates) {
      await this.sendMessage(message, integration);
    }

    await this.campaignsService.refreshCampaignSummary(campaign.id);
  }

  private isDispatchable(message: CampaignMessageRecord, campaignId: string): boolean {
    if (message.campaignId !== campaignId) {
      return false;
    }
    if (message.status !== 'pending') {
      return false;
    }
    if (!message.payload || Object.keys(message.payload).length === 0) {
      return false;
    }
    if (!message.nextAttemptAt) {
      return true;
    }

    return new Date(message.nextAttemptAt).getTime() <= Date.now();
  }

  private async sendMessage(
    message: CampaignMessageRecord,
    integration: IntegrationRecord,
  ): Promise<void> {
    try {
      const response = await this.metaGraph.sendMessage(integration, message.payload);
      const providerMessageId = Array.isArray(response.messages)
        ? String((response.messages[0] as Record<string, unknown>)?.id ?? '')
        : '';

      await this.database.write((state) => {
        const item = state.campaignMessages.find((record) => record.id === message.id);
        if (!item) {
          return;
        }

        item.status = 'accepted';
        item.providerMessageId = providerMessageId;
        item.attemptCount += 1;
        item.lastAttemptAt = nowIso();
        item.nextAttemptAt = null;
        item.updatedAt = nowIso();

        state.messageEvents.push({
          id: newId(),
          campaignMessageId: item.id,
          providerMessageId,
          eventType: 'send.accepted',
          status: 'accepted',
          payload: response,
          occurredAt: nowIso(),
          receivedAt: nowIso(),
          dedupeKey: `accepted:${providerMessageId}`,
        });
      });
    } catch (error) {
      const metaError = error as MetaApiError;
      const retryDelayMs = classifyRetryDelay(metaError.code);

      await this.database.write((state) => {
        const item = state.campaignMessages.find((record) => record.id === message.id);
        if (!item) {
          return;
        }

        item.attemptCount += 1;
        item.lastAttemptAt = nowIso();
        item.providerErrorCode = metaError.code ? String(metaError.code) : null;
        item.providerErrorTitle = metaError.message;
        item.providerErrorMessage = JSON.stringify(metaError.payload ?? {});
        item.updatedAt = nowIso();

        if (retryDelayMs && item.attemptCount < 5) {
          item.nextAttemptAt = new Date(Date.now() + retryDelayMs).toISOString();
        } else {
          item.status = 'failed';
          item.failedAt = nowIso();
        }
      });
    }
  }
}

const classifyRetryDelay = (code?: number): number | null => {
  if (!code) {
    return 30_000;
  }

  if (code === 130429) {
    return 60_000;
  }

  if (code === 131056) {
    return 4 * 1_000;
  }

  if (code >= 500) {
    return 120_000;
  }

  return null;
};
