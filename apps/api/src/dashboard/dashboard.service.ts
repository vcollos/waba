import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class DashboardService {
  constructor(private readonly database: DatabaseService) {}

  async summary() {
    const state = await this.database.read();
    const totalDelivered = state.campaignMessages.filter((item) => item.status === 'delivered').length;
    const totalRead = state.campaignMessages.filter((item) => item.status === 'read').length;
    const totalFailed = state.campaignMessages.filter((item) => item.status === 'failed').length;

    return {
      contacts: state.contacts.length,
      optedOutContacts: state.contacts.filter((item) => item.isOptedOut).length,
      lists: state.lists.length,
      integrations: state.integrations.length,
      templates: state.templates.length,
      flows: state.flows.length,
      campaigns: state.campaigns.length,
      messages: state.campaignMessages.length,
      flowResponses: state.flowResponses.length,
      delivered: totalDelivered,
      read: totalRead,
      failed: totalFailed,
      recentCampaigns: state.campaigns
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 5),
    };
  }
}
