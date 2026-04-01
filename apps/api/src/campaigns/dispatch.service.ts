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
  private readonly inFlightByCampaign = new Map<string, Set<string>>();

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
      const { activeCampaigns, integrations } = await this.loadDispatchTargets();

      for (const campaign of activeCampaigns) {
        await this.dispatchCampaign(campaign, integrations);
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

    const inFlightCount = this.getInFlightCount(campaign.id);
    const availableSlots = Math.max(0, campaign.sendRateMps - inFlightCount);
    if (availableSlots === 0) {
      return;
    }

    const candidates = await this.claimDispatchBatch(campaign.id, availableSlots);

    if (candidates.length === 0) {
      if (inFlightCount === 0) {
        await this.campaignsService.refreshCampaignSummary(campaign.id);
      }
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
      this.launchSend(message, integration);
    }
  }

  private async loadDispatchTargets(): Promise<{
    activeCampaigns: CampaignRecord[];
    integrations: IntegrationRecord[];
  }> {
    return this.database.readDispatchTargets();
  }

  private async claimDispatchBatch(
    campaignId: string,
    batchSize: number,
  ): Promise<CampaignMessageRecord[]> {
    const claimed: CampaignMessageRecord[] = [];
    const leaseUntil = new Date(Date.now() + DISPATCH_CLAIM_LEASE_MS).toISOString();

    await this.database.write((state) => {
      const candidates = state.campaignMessages
        .filter((message) => this.isDispatchable(message, campaignId))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .slice(0, batchSize);

      for (const item of candidates) {
        item.nextAttemptAt = leaseUntil;
        item.updatedAt = nowIso();
        claimed.push(structuredClone(item));
      }
    });

    return claimed;
  }

  private launchSend(message: CampaignMessageRecord, integration: IntegrationRecord) {
    this.addInFlight(message.campaignId, message.id);

    void this.sendMessage(message, integration)
      .catch((error) => {
        this.logger.error(
          `Dispatch send failed for message ${message.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      })
      .finally(() => {
        this.removeInFlight(message.campaignId, message.id);
      });
  }

  private getInFlightCount(campaignId: string): number {
    return this.inFlightByCampaign.get(campaignId)?.size ?? 0;
  }

  private addInFlight(campaignId: string, messageId: string) {
    const entries = this.inFlightByCampaign.get(campaignId) ?? new Set<string>();
    entries.add(messageId);
    this.inFlightByCampaign.set(campaignId, entries);
  }

  private removeInFlight(campaignId: string, messageId: string) {
    const entries = this.inFlightByCampaign.get(campaignId);
    if (!entries) {
      return;
    }

    entries.delete(messageId);
    if (entries.size === 0) {
      this.inFlightByCampaign.delete(campaignId);
    }
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

const DISPATCH_CLAIM_LEASE_MS = 120_000;
