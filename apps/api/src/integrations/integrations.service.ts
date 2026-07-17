import { BadGatewayException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { CryptoService } from '../common/crypto.service';
import { isWithinScope, resolveClientScope } from '../common/scope';
import { DatabaseService } from '../database/database.service';
import { newId, nowIso } from '../database/helpers';
import { FlowCacheRecord, IntegrationRecord, TemplateCacheRecord, UserSession } from '../database/types';
import { MetaApiError, MetaGraphService } from './meta-graph.service';

export interface SaveIntegrationInput {
  id?: string;
  name: string;
  graphApiBase?: string;
  graphApiVersion: string;
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  appSecret?: string;
  webhookCallbackUrl?: string;
  clientId?: string | null;
  status?: 'active' | 'inactive';
}

export interface EnvIntegrationInput extends SaveIntegrationInput {}

export type SanitizedIntegration = Omit<
  IntegrationRecord,
  'accessTokenCiphertext' | 'verifyTokenCiphertext' | 'appSecretCiphertext'
>;

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly metaGraph: MetaGraphService,
  ) {}

  async list(session: UserSession): Promise<SanitizedIntegration[]> {
    const scope = resolveClientScope(session);
    const integrations = await this.database.listIntegrationsInDatabase();
    return integrations
      .filter((integration) => isWithinScope(scope, integration.clientId))
      .map((integration) => this.sanitize(integration));
  }

  async getById(id: string): Promise<IntegrationRecord> {
    const integrations = await this.database.listIntegrationsInDatabase();
    const integration = integrations.find((item) => item.id === id);
    if (!integration) {
      throw new NotFoundException('Integração não encontrada');
    }

    return integration;
  }

  /**
   * Resolve os appSecrets (já decifrados) das integrações referenciadas por um
   * webhook da Meta, identificadas por waba_id (`entry[].id`) e/ou
   * phone_number_id (`changes[].value.metadata.phone_number_id`).
   *
   * Fail-closed: retorna `[]` se nenhuma referência casar com integração
   * conhecida OU se as casadas não tiverem appSecret configurado — o guard
   * então rejeita (401) sem processar. Nunca loga/retorna o segredo em claro
   * para fora deste fluxo de verificação.
   */
  async resolveWebhookAppSecrets(refs: {
    wabaIds: string[];
    phoneNumberIds: string[];
  }): Promise<string[]> {
    const integrations = await this.database.listIntegrationsInDatabase();
    const matched = integrations.filter(
      (integration) =>
        refs.wabaIds.includes(integration.wabaId) ||
        refs.phoneNumberIds.includes(integration.phoneNumberId),
    );

    // Uma entrega da Meta é assinada com UM único appSecret (o do Meta App que
    // emitiu o webhook), sobre o corpo inteiro. Coletamos os segredos distintos
    // das integrações referenciadas; o guard aceita se a assinatura casar com
    // qualquer um deles. Isso cobre o caso de várias WABAs sob o mesmo Meta App
    // (mesmo segredo) sem afrouxar o fail-closed: todo segredo testado pertence
    // a uma integração nomeada no próprio corpo.
    const secrets = new Set<string>();
    for (const integration of matched) {
      try {
        const secret = this.crypto.decrypt(integration.appSecretCiphertext);
        if (secret) {
          secrets.add(secret);
        }
      } catch {
        // decrypt falho => ignora esta integração (fail-closed).
      }
    }

    return [...secrets];
  }

  async hasVerifyToken(token: string): Promise<boolean> {
    const integrations = await this.database.listIntegrationsInDatabase();
    return integrations.some((integration) => {
      try {
        return this.crypto.decrypt(integration.verifyTokenCiphertext) === token;
      } catch {
        return false;
      }
    });
  }

  async upsertFromEnv(input: EnvIntegrationInput): Promise<SanitizedIntegration> {
    const integrations = await this.database.listIntegrationsInDatabase();
    const existing = integrations.find(
      (integration) =>
        integration.wabaId === input.wabaId &&
        integration.phoneNumberId === input.phoneNumberId,
    );

    // Env é apenas bootstrap inicial. Se a integração já existe, a UI é a fonte
    // de verdade — não sobrescrever nome, tokens, cliente ou status a cada boot.
    if (existing) {
      return this.sanitize(existing);
    }

    return this.save(input, {
      id: 'system-env',
      email: 'system@local',
      name: 'Sistema',
      role: 'admin',
      clientIds: [],
    });
  }

  async save(input: SaveIntegrationInput, actor: UserSession): Promise<SanitizedIntegration> {
    const current = input.id ? await this.getById(input.id) : null;
    const integration: IntegrationRecord = {
      id: current?.id ?? newId(),
      name: input.name,
      graphApiBase: input.graphApiBase ?? 'https://graph.facebook.com',
      graphApiVersion: input.graphApiVersion,
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      accessTokenCiphertext:
        input.accessToken && input.accessToken !== '********'
          ? this.crypto.encrypt(input.accessToken)
          : (current?.accessTokenCiphertext ?? ''),
      verifyTokenCiphertext:
        input.verifyToken && input.verifyToken !== '********'
          ? this.crypto.encrypt(input.verifyToken)
          : (current?.verifyTokenCiphertext ?? ''),
      appSecretCiphertext:
        input.appSecret && input.appSecret !== '********'
          ? this.crypto.encrypt(input.appSecret)
          : (current?.appSecretCiphertext ?? null),
      webhookCallbackUrl: input.webhookCallbackUrl ?? current?.webhookCallbackUrl ?? null,
      clientId: input.clientId !== undefined ? input.clientId : (current?.clientId ?? null),
      status: input.status ?? current?.status ?? 'active',
      lastSyncAt: current?.lastSyncAt ?? null,
      lastHealthcheckAt: current?.lastHealthcheckAt ?? null,
      createdAt: current?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
    };

    await this.database.saveIntegrationInDatabase(integration);

    void this.audit
      .log({
        actorUserId: actor.id,
        action: current ? 'integration.updated' : 'integration.created',
        entityType: 'integration',
      entityId: integration.id,
        metadata: {
          wabaId: integration.wabaId,
          phoneNumberId: integration.phoneNumberId,
        },
      })
      .catch(() => undefined);

    return this.sanitize(integration);
  }

  async testConnection(id: string): Promise<Record<string, unknown>> {
    const integration = await this.getById(id);
    const result = await this.wrapMetaCall(() => this.metaGraph.testConnection(integration));
    const updatedAt = nowIso();
    await this.database.updateIntegrationTimestampsInDatabase(id, {
      lastHealthcheckAt: updatedAt,
      updatedAt,
    });

    return result;
  }

  async syncTemplates(id: string, actor: UserSession): Promise<TemplateCacheRecord[]> {
    const integration = await this.getById(id);
    if (!isWithinScope(resolveClientScope(actor), integration.clientId)) {
      throw new NotFoundException('Integração não encontrada');
    }
    const templates = await this.wrapMetaCall(() => this.metaGraph.syncTemplates(integration));
    const updatedAt = nowIso();
    await this.database.replaceTemplatesInDatabase(id, templates);
    await this.database.updateIntegrationTimestampsInDatabase(id, {
      lastSyncAt: updatedAt,
      updatedAt,
    });

    void this.audit
      .log({
        actorUserId: actor.id,
        action: 'templates.synced',
        entityType: 'integration',
        entityId: id,
        metadata: { count: templates.length },
      })
      .catch(() => undefined);

    return templates;
  }

  /** (Re)atribui uma integração a um cliente (ou null para desvincular). Collos only. */
  async setClient(
    id: string,
    clientId: string | null,
    actor: UserSession,
  ): Promise<SanitizedIntegration> {
    const integration = await this.getById(id);
    const updated: IntegrationRecord = {
      ...integration,
      clientId: clientId || null,
      updatedAt: nowIso(),
    };
    await this.database.saveIntegrationInDatabase(updated);

    void this.audit
      .log({
        actorUserId: actor.id,
        action: 'integration.client_assigned',
        entityType: 'integration',
        entityId: id,
        metadata: { clientId: updated.clientId },
      })
      .catch(() => undefined);

    return this.sanitize(updated);
  }

  async syncFlows(id: string, actor: UserSession): Promise<FlowCacheRecord[]> {
    const integration = await this.getById(id);
    if (!isWithinScope(resolveClientScope(actor), integration.clientId)) {
      throw new NotFoundException('Integração não encontrada');
    }
    const flows = await this.wrapMetaCall(() => this.metaGraph.syncFlows(integration));
    const updatedAt = nowIso();
    await this.database.replaceFlowsInDatabase(id, flows);
    await this.database.updateIntegrationTimestampsInDatabase(id, {
      lastSyncAt: updatedAt,
      updatedAt,
    });

    void this.audit
      .log({
        actorUserId: actor.id,
        action: 'flows.synced',
        entityType: 'integration',
        entityId: id,
        metadata: { count: flows.length },
      })
      .catch(() => undefined);

    return flows;
  }

  private sanitize(integration: IntegrationRecord): SanitizedIntegration {
    const { accessTokenCiphertext, verifyTokenCiphertext, appSecretCiphertext, ...safe } =
      integration;
    void accessTokenCiphertext;
    void verifyTokenCiphertext;
    void appSecretCiphertext;
    return safe;
  }

  private async wrapMetaCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof MetaApiError) {
        throw new BadGatewayException(error.message);
      }

      if (error instanceof Error) {
        throw new BadGatewayException(error.message);
      }

      throw error;
    }
  }
}
