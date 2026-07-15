import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { extractTemplateMediaHeader } from '../database/helpers';
import { isWithinScope, resolveClientScope } from '../common/scope';
import { TemplateCacheRecord, UserSession } from '../database/types';

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

  /**
   * Templates visíveis no escopo, pelo tenant EFETIVO de cada template:
   * `template.clientId` (override por etiqueta) ?? `integration.clientId`.
   * Uma mesma conta WABA pode servir vários tenants; a etiqueta permite que um
   * template de integração compartilhada apareça só para o tenant marcado.
   */
  async templates(actor: UserSession, integrationId?: string, requestedClientId?: string) {
    const scope = resolveClientScope(actor, requestedClientId);
    const templates = await this.database.listTemplatesInDatabase(integrationId);
    if (scope === null) {
      return this.decorateTemplates(templates);
    }
    const integrations = await this.database.listIntegrationsInDatabase();
    const integrationClientById = new Map<string, string | null>(
      integrations.map((integration) => [integration.id, integration.clientId ?? null]),
    );
    return this.decorateTemplates(
      templates.filter((t) =>
        isWithinScope(scope, t.clientId ?? integrationClientById.get(t.integrationId) ?? null),
      ),
    );
  }

  private decorateTemplates(templates: TemplateCacheRecord[]) {
    return templates
      .map((t) => ({ ...t, mediaHeader: extractTemplateMediaHeader(t.components) }))
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
