import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class ResultsService {
  constructor(private readonly database: DatabaseService) {}

  async listFlowResponses(filters?: {
    campaignId?: string;
    flowCacheId?: string;
    contactId?: string;
  }) {
    const state = await this.database.read();

    return state.flowResponses
      .filter((response) => {
        if (filters?.campaignId && response.campaignId !== filters.campaignId) {
          return false;
        }
        if (filters?.flowCacheId && response.flowCacheId !== filters.flowCacheId) {
          return false;
        }
        if (filters?.contactId && response.contactId !== filters.contactId) {
          return false;
        }
        return true;
      })
      .map((response) => {
        const campaign = response.campaignId
          ? state.campaigns.find((item) => item.id === response.campaignId) ?? null
          : null;
        const contact = response.contactId
          ? state.contacts.find((item) => item.id === response.contactId) ?? null
          : null;
        const flow = response.flowCacheId
          ? state.flows.find((item) => item.id === response.flowCacheId) ?? null
          : response.metaFlowId
            ? state.flows.find((item) => item.metaFlowId === response.metaFlowId) ?? null
            : null;
        const template = response.templateCacheId
          ? state.templates.find((item) => item.id === response.templateCacheId) ?? null
          : null;

        return {
          ...response,
          campaignName: campaign?.name ?? null,
          contactName: contact?.name ?? null,
          contactPhone: contact?.phoneE164 ?? null,
          flowName: flow?.name ?? null,
          templateName: template?.name ?? null,
          detectedPayloadDefinitions: flow?.completionPayloadDefinitions ?? [],
        };
      })
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  }

  async summary() {
    const responses = await this.listFlowResponses();
    const byFlow = responses.reduce<Record<string, number>>((accumulator, response) => {
      const key = response.flowName ?? response.metaFlowId ?? 'Flow não identificado';
      accumulator[key] = (accumulator[key] ?? 0) + 1;
      return accumulator;
    }, {});

    return {
      totalFlowResponses: responses.length,
      byFlow: Object.entries(byFlow)
        .map(([flowName, count]) => ({ flowName, count }))
        .sort((left, right) => right.count - left.count),
    };
  }
}
