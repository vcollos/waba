import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class DashboardService {
  constructor(private readonly database: DatabaseService) {}

  async summary() {
    const state = await this.database.readMetaSnapshot();
    const [contactsRow, optedOutRow, listsRow, campaignMessages, flowResponses] = await Promise.all([
      this.database.postgresQuery<{ count: string }>('SELECT COUNT(*)::text AS count FROM contacts'),
      this.database.postgresQuery<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM contacts WHERE is_opted_out = true',
      ),
      this.database.postgresQuery<{ count: string }>('SELECT COUNT(*)::text AS count FROM lists'),
      this.database.listCampaignMessagesInDatabase(),
      this.database.listFlowResponsesInDatabase(),
    ]);

    const relationalCounts = {
      contacts: Number(contactsRow[0]?.count ?? 0),
      optedOutContacts: Number(optedOutRow[0]?.count ?? 0),
      lists: Number(listsRow[0]?.count ?? 0),
    };
    const totalDelivered = campaignMessages.filter((item) => item.status === 'delivered').length;
    const totalRead = campaignMessages.filter((item) => item.status === 'read').length;
    const totalFailed = campaignMessages.filter((item) => item.status === 'failed').length;

    return {
      contacts: relationalCounts.contacts,
      optedOutContacts: relationalCounts.optedOutContacts,
      lists: relationalCounts.lists,
      integrations: state.integrations.length,
      templates: state.templates.length,
      flows: state.flows.length,
      campaigns: state.campaigns.length,
      messages: campaignMessages.length,
      flowResponses: flowResponses.length,
      delivered: totalDelivered,
      read: totalRead,
      failed: totalFailed,
      recentCampaigns: [...state.campaigns]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 5),
    };
  }
}
