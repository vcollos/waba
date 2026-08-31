import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { extractTemplateMediaHeader } from '../database/helpers';
import { clientIdsByIntegration, isWithinScopeAny, resolveClientScope } from '../common/scope';
import { TemplateCacheRecord, UserSession } from '../database/types';

@Injectable()
export class LibraryService {
  constructor(private readonly database: DatabaseService) {}

  /** Conjunto de integrações visíveis no escopo do usuário (vínculo N:N). */
  private async allowedIntegrationIds(
    actor: UserSession,
    requestedClientId?: string,
  ): Promise<Set<string> | null> {
    const scope = resolveClientScope(actor, requestedClientId);
    if (scope === null) {
      return null; // Collos sem filtro: todas as integrações
    }
    const links = await this.database.listClientIntegrationsInDatabase();
    return new Set(
      links.filter((link) => link.clientId === scope).map((link) => link.integrationId),
    );
  }

  /**
   * Templates visíveis no escopo, pelo tenant EFETIVO de cada template:
   * `template.clientId` (override por etiqueta) quando existe; senão os tenants
   * vinculados à integração. Uma conta WABA compartilhada expõe seus templates a
   * todos os tenants vinculados; a etiqueta restringe um template a um só.
   */
  async templates(actor: UserSession, integrationId?: string, requestedClientId?: string) {
    const scope = resolveClientScope(actor, requestedClientId);
    const templates = await this.database.listTemplatesInDatabase(integrationId);
    if (scope === null) {
      return this.decorateTemplates(templates);
    }
    const links = await this.database.listClientIntegrationsInDatabase();
    const clientIdsByIntegrationId = clientIdsByIntegration(links);
    return this.decorateTemplates(
      templates.filter((t) =>
        isWithinScopeAny(
          scope,
          t.clientId ? [t.clientId] : clientIdsByIntegrationId.get(t.integrationId) ?? [],
        ),
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
