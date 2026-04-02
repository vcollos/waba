import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class LibraryService {
  constructor(private readonly database: DatabaseService) {}

  async templates(integrationId?: string) {
    const templates = await this.database.listTemplatesInDatabase(integrationId);
    return templates.sort((left, right) => right.lastSyncedAt.localeCompare(left.lastSyncedAt));
  }

  async flows(integrationId?: string) {
    const flows = await this.database.listFlowsInDatabase(integrationId);
    return flows.sort((left, right) => right.lastSyncedAt.localeCompare(left.lastSyncedAt));
  }
}
