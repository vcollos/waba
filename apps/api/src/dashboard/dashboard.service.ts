import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class DashboardService {
  constructor(private readonly database: DatabaseService) {}

  async summary() {
    const state = await this.database.readMeta();
    const totalDelivered = state.campaignMessages.filter((item) => item.status === 'delivered').length;
    const totalRead = state.campaignMessages.filter((item) => item.status === 'read').length;
    const totalFailed = state.campaignMessages.filter((item) => item.status === 'failed').length;
    const relationalCounts = await this.database.execute((database) => {
      const contacts = Number(
        (database.prepare('SELECT COUNT(*) as count FROM contacts').get() as { count: number }).count ?? 0,
      );
      const optedOutContacts = Number(
        (
          database
            .prepare('SELECT COUNT(*) as count FROM contacts WHERE is_opted_out = 1')
            .get() as { count: number }
        ).count ?? 0,
      );
      const lists = Number(
        (database.prepare('SELECT COUNT(*) as count FROM lists').get() as { count: number }).count ?? 0,
      );
      return { contacts, optedOutContacts, lists };
    });

    return {
      contacts: relationalCounts.contacts,
      optedOutContacts: relationalCounts.optedOutContacts,
      lists: relationalCounts.lists,
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
