import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { CampaignRecord, UserSession, isCollosRole } from '../database/types';

export interface DashboardQuery {
  clientId?: string | null;
  from?: string | null;
  to?: string | null;
}

@Injectable()
export class DashboardService {
  constructor(private readonly database: DatabaseService) {}

  async summary(session: UserSession, query: DashboardQuery = {}) {
    const state = await this.database.readMetaSnapshot();
    const collos = isCollosRole(session.role);

    // Papéis de cliente são sempre forçados ao próprio tenant; Collos pode
    // filtrar por um cliente específico ou ver todos (clientId nulo).
    const scopeClientId = collos ? query.clientId ?? null : session.clientId ?? null;

    const clientName = (clientId?: string | null): string | null => {
      if (!clientId) {
        return null;
      }
      return state.clients.find((client) => client.id === clientId)?.name ?? null;
    };

    const withinPeriod = (createdAt: string): boolean => {
      if (query.from && createdAt < query.from) {
        return false;
      }
      if (query.to && createdAt > query.to) {
        return false;
      }
      return true;
    };

    const campaigns = state.campaigns.filter((campaign) => {
      if (scopeClientId && campaign.clientId !== scopeClientId) {
        return false;
      }
      return withinPeriod(campaign.createdAt);
    });

    const campaignIds = new Set(campaigns.map((campaign) => campaign.id));
    const flowResponses = await this.database.listFlowResponsesInDatabase();
    const scopedFlowResponses = flowResponses.filter(
      (response) => response.campaignId && campaignIds.has(response.campaignId),
    );

    const totals = campaigns.reduce(
      (acc, campaign) => {
        acc.total += campaign.summary.total;
        acc.sent += campaign.summary.sent;
        acc.delivered += campaign.summary.delivered;
        acc.read += campaign.summary.read;
        acc.failed += campaign.summary.failed;
        return acc;
      },
      { total: 0, sent: 0, delivered: 0, read: 0, failed: 0 },
    );

    const activeIntegrations = state.integrations.filter(
      (integration) =>
        integration.status === 'active' &&
        (!scopeClientId || integration.clientId === scopeClientId),
    ).length;

    return {
      scope: collos ? ('collos' as const) : ('client' as const),
      clientId: scopeClientId,
      kpis: {
        activeClients: state.clients.filter((client) => client.status === 'active').length,
        activeIntegrations,
        campaigns: campaigns.length,
        total: totals.total,
        sent: totals.sent,
        delivered: totals.delivered,
        read: totals.read,
        failed: totals.failed,
        flowResponses: scopeClientId ? scopedFlowResponses.length : flowResponses.length,
        estimatedAmount: 0,
      },
      recentCampaigns: [...campaigns]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 8)
        .map((campaign) => this.toCampaignRow(campaign, clientName(campaign.clientId))),
      topClients: collos ? this.topClients(campaigns, clientName) : [],
    };
  }

  private toCampaignRow(campaign: CampaignRecord, clientName: string | null) {
    return {
      id: campaign.id,
      clientId: campaign.clientId ?? null,
      clientName,
      name: campaign.name,
      status: campaign.status,
      total: campaign.summary.total,
      sent: campaign.summary.sent,
      delivered: campaign.summary.delivered,
      read: campaign.summary.read,
      failed: campaign.summary.failed,
      createdAt: campaign.createdAt,
    };
  }

  private topClients(
    campaigns: CampaignRecord[],
    clientName: (clientId?: string | null) => string | null,
  ) {
    const byClient = new Map<
      string,
      { clientId: string; sent: number; delivered: number; failed: number }
    >();

    for (const campaign of campaigns) {
      if (!campaign.clientId) {
        continue;
      }
      const entry = byClient.get(campaign.clientId) ?? {
        clientId: campaign.clientId,
        sent: 0,
        delivered: 0,
        failed: 0,
      };
      entry.sent += campaign.summary.sent;
      entry.delivered += campaign.summary.delivered;
      entry.failed += campaign.summary.failed;
      byClient.set(campaign.clientId, entry);
    }

    return [...byClient.values()]
      .map((entry) => ({
        ...entry,
        clientName: clientName(entry.clientId),
        estimatedAmount: 0,
      }))
      .sort((left, right) => right.sent - left.sent)
      .slice(0, 6);
  }
}
