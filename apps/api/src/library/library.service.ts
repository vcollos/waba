import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { isWithinScope, resolveClientScope } from '../common/scope';
import { UserSession } from '../database/types';

@Injectable()
export class LibraryService {
  constructor(private readonly database: DatabaseService) {}

  /** Conjunto de integrações visíveis no escopo do usuário (por clientId da integração). */
  private async allowedIntegrationIds(
    actor: UserSession,
    requestedClientId?: string,
  ): Promise<Set<string> | null> {
    const scope = resolveClientScope(actor, requestedClientId);
    if (scope === null) {
      return null; // Collos sem filtro: todas as integrações
    }
    const integrations = await this.database.listIntegrationsInDatabase();
    return new Set(
      integrations.filter((i) => isWithinScope(scope, i.clientId)).map((i) => i.id),
    );
  }

  async templates(actor: UserSession, integrationId?: string, requestedClientId?: string) {
    const allowed = await this.allowedIntegrationIds(actor, requestedClientId);
    const templates = await this.database.listTemplatesInDatabase(integrationId);
    return templates
      .filter((t) => allowed === null || allowed.has(t.integrationId))
      .sort((left, right) => right.lastSyncedAt.localeCompare(left.lastSyncedAt));
  }

  async flows(actor: UserSession, integrationId?: string, requestedClientId?: string) {
    const allowed = await this.allowedIntegrationIds(actor, requestedClientId);
    const flows = await this.database.listFlowsInDatabase(integrationId);
    return flows
      .filter((f) => allowed === null || allowed.has(f.integrationId))
      .sort((left, right) => right.lastSyncedAt.localeCompare(left.lastSyncedAt));
  }
}
