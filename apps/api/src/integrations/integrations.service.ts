import { BadGatewayException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { CryptoService } from '../common/crypto.service';
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

  async list(): Promise<SanitizedIntegration[]> {
    const integrations = await this.database.listIntegrationsInDatabase();
    return integrations.map((integration) => this.sanitize(integration));
  }

  async getById(id: string): Promise<IntegrationRecord> {
    const integrations = await this.database.listIntegrationsInDatabase();
    const integration = integrations.find((item) => item.id === id);
    if (!integration) {
      throw new NotFoundException('Integração não encontrada');
    }

    return integration;
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

    return this.save(
      {
        ...input,
        id: existing?.id,
      },
      {
        id: 'system-env',
        email: 'system@local',
        role: 'admin',
      },
    );
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
      status: 'active',
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

  async syncFlows(id: string, actor: UserSession): Promise<FlowCacheRecord[]> {
    const integration = await this.getById(id);
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
