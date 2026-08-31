import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { integrationIdsForClient, resolveClientScope } from '../common/scope';
import { campaignFunnel, sumCampaignSummaries } from '../common/campaign-metrics';
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

    // Cliente é forçado a um dos seus tenants; Collos filtra por um cliente ou vê todos.
    const scopeClientId = resolveClientScope(session, query.clientId);

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

    // Soma os baldes brutos e só então deriva o funil: somar funis já derivados
    // daria o mesmo resultado, mas somar baldes mantém uma única fonte de verdade.
    const totals = campaignFunnel(sumCampaignSummaries(campaigns.map((campaign) => campaign.summary)));

    // Conta integrações ATIVAS que o tenant pode usar: uma conta WABA
    // compartilhada conta para todos os tenants vinculados.
    const allowedIntegrationIds = scopeClientId
      ? integrationIdsForClient(state.clientIntegrations, scopeClientId)
      : null;
    const activeIntegrations = state.integrations.filter(
      (integration) =>
        integration.status === 'active' &&
        (!allowedIntegrationIds || allowedIntegrationIds.has(integration.id)),
    ).length;

    return {
      scope: collos ? ('collos' as const) : ('client' as const),
      clientId: scopeClientId,
      kpis: {
        activeClients: state.clients.filter((client) => client.status === 'active').length,
        activeIntegrations,
        campaigns: campaigns.length,
        total: totals.total,
        sent: totals.sentTotal,
        delivered: totals.deliveredTotal,
        read: totals.readTotal,
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
    const funnel = campaignFunnel(campaign.summary);
    return {
      id: campaign.id,
      clientId: campaign.clientId ?? null,
      clientName,
      name: campaign.name,
      status: campaign.status,
      total: funnel.total,
      sent: funnel.sentTotal,
      delivered: funnel.deliveredTotal,
      read: funnel.readTotal,
      failed: funnel.failed,
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
      const funnel = campaignFunnel(campaign.summary);
      entry.sent += funnel.sentTotal;
      entry.delivered += funnel.deliveredTotal;
      entry.failed += funnel.failed;
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
