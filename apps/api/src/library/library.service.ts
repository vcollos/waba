import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class LibraryService {
  constructor(private readonly database: DatabaseService) {}

  async templates(integrationId?: string) {
    const state = await this.database.read();
    return state.templates
      .filter((template) => !integrationId || template.integrationId === integrationId)
      .sort((left, right) => right.lastSyncedAt.localeCompare(left.lastSyncedAt));
  }

  async flows(integrationId?: string) {
    const state = await this.database.read();
    return state.flows
      .filter((flow) => !integrationId || flow.integrationId === integrationId)
      .sort((left, right) => right.lastSyncedAt.localeCompare(left.lastSyncedAt));
  }
}
