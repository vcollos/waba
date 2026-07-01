import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

export interface AuditFilters {
  actorUserId?: string;
  action?: string;
  entityType?: string;
  from?: string;
  to?: string;
}

export interface AuditEntry {
  id: string;
  createdAt: string;
  actorUserId: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
}

@Injectable()
export class AuditReadService {
  constructor(private readonly database: DatabaseService) {}

  async list(filters: AuditFilters = {}): Promise<AuditEntry[]> {
    const state = await this.database.readMetaSnapshot();
    const userName = (id?: string | null): string | null =>
      id ? state.users.find((user) => user.id === id)?.name ?? null : null;

    return state.auditLogs
      .filter((log) => {
        if (filters.actorUserId && log.actorUserId !== filters.actorUserId) return false;
        if (filters.action && log.action !== filters.action) return false;
        if (filters.entityType && log.entityType !== filters.entityType) return false;
        if (filters.from && log.createdAt < filters.from) return false;
        if (filters.to && log.createdAt > filters.to) return false;
        return true;
      })
      .map((log) => ({
        id: log.id,
        createdAt: log.createdAt,
        actorUserId: log.actorUserId ?? null,
        actorName: userName(log.actorUserId),
        action: log.action,
        entityType: log.entityType,
        entityId: log.entityId,
        metadata: log.metadata ?? {},
      }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 500);
  }
}
