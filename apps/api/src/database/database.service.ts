import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  AppState,
  AuditLogRecord,
  CampaignAudienceConfig,
  CampaignAudienceSnapshot,
  CampaignMessageRecord,
  CampaignRecord,
  ClientIntegrationLink,
  ContactRecord,
  FlowCacheRecord,
  CampaignTestSendRecord,
  FlowResponseRecord,
  ImportRecord,
  IntegrationRecord,
  ClientRecord,
  ListMemberRecord,
  ListRecord,
  MessageEventRecord,
  OptOutRecord,
  PricingRateRecord,
  ReportSettingsRecord,
  DEFAULT_NOTA_FISCAL_PCT,
  TemplateCacheRecord,
  TransactionalDispatchRecord,
  UserRecord,
  emptyState,
} from './types';
import { newId, nowIso } from './helpers';
import { getEnv } from '../common/env';
import { hashPassword } from '../common/password';

/** Marcador do backfill único que recupera vínculos a partir das campanhas. */
const CAMPAIGN_LINK_BACKFILL = 'integration_clients_from_campaigns_v1';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly env = getEnv();
  private readonly sqlitePath = this.env.sqlitePath;
  private readonly legacyDataFilePath = this.env.legacyDataFilePath;
  private readonly postgresUrl = this.env.postgresUrl;
  private database?: DatabaseSync;
  private metaClient?: Pool;
  private metaStateCache = emptyState();
  private initPromise?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();

  async read(): Promise<AppState> {
    await this.ensureReady();
    return this.readCurrentState();
  }

  async readMeta(): Promise<AppState> {
    await this.ensureReady();
    return this.readMetaState();
  }

  async readMetaSnapshot(): Promise<Readonly<AppState>> {
    await this.ensureReady();
    return this.metaStateCache;
  }

  async readDispatchTargets(): Promise<{
    activeCampaigns: CampaignRecord[];
    integrations: AppState['integrations'];
  }> {
    await this.ensureReady();
    const activeCampaigns = this.metaStateCache.campaigns
      .filter((campaign) => campaign.status === 'queued' || campaign.status === 'sending')
      .map((campaign) => structuredClone(campaign));
    if (activeCampaigns.length === 0) {
      return { activeCampaigns: [], integrations: [] };
    }

    const integrationIds = new Set(activeCampaigns.map((campaign) => campaign.integrationId));
    const integrations = this.metaStateCache.integrations
      .filter((integration) => integrationIds.has(integration.id))
      .map((integration) => structuredClone(integration));

    return { activeCampaigns, integrations };
  }

  async write(mutator: (state: AppState) => void | Promise<void>): Promise<void> {
    const task = this.queue.then(async () => {
      await this.ensureReady();
      const state = structuredClone(this.metaStateCache);
      await mutator(state);
      const compactedState = this.prepareStateForStorage(state);
      this.metaStateCache = structuredClone(compactedState);
      await this.persistMetaState(compactedState);
    });
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  async persist(state: AppState): Promise<void> {
    const task = this.queue.then(async () => {
      await this.ensureReady();
      this.persistRelationalState(state);
      const compactedState = this.prepareStateForStorage(state);
      this.metaStateCache = structuredClone(compactedState);
      await this.persistMetaState(compactedState);
    });
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  async listClients(): Promise<ClientRecord[]> {
    await this.ensureReady();
    return structuredClone(this.metaStateCache.clients);
  }

  async listUsers(): Promise<UserRecord[]> {
    await this.ensureReady();
    return structuredClone(this.metaStateCache.users);
  }

  async getClient(id: string): Promise<ClientRecord | undefined> {
    await this.ensureReady();
    const found = this.metaStateCache.clients.find((client) => client.id === id);
    return found ? structuredClone(found) : undefined;
  }

  async saveClient(client: ClientRecord): Promise<void> {
    await this.write((state) => {
      const index = state.clients.findIndex((item) => item.id === client.id);
      if (index >= 0) {
        state.clients[index] = client;
      } else {
        state.clients.push(client);
      }
    });
  }

  async getUser(id: string): Promise<UserRecord | undefined> {
    await this.ensureReady();
    const found = this.metaStateCache.users.find((user) => user.id === id);
    return found ? structuredClone(found) : undefined;
  }

  async saveUser(user: UserRecord): Promise<void> {
    await this.write((state) => {
      const index = state.users.findIndex((item) => item.id === user.id);
      if (index >= 0) {
        state.users[index] = user;
      } else {
        state.users.push(user);
      }
    });
  }

  async findUserByEmail(email: string): Promise<UserRecord | undefined> {
    await this.ensureReady();
    const normalized = email.trim().toLowerCase();
    const found = this.metaStateCache.users.find(
      (user) => user.email.trim().toLowerCase() === normalized,
    );
    return found ? structuredClone(found) : undefined;
  }

  async touchUserLogin(id: string, at: string): Promise<void> {
    await this.write((state) => {
      const user = state.users.find((item) => item.id === id);
      if (user) {
        user.lastLoginAt = at;
        user.updatedAt = at;
      }
    });
  }

  async execute<T>(callback: (database: DatabaseSync) => T): Promise<T> {
    const task = this.queue.then(async () => {
      await this.ensureReady();
      return callback(this.database!);
    });
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  async transaction<T>(callback: (database: DatabaseSync) => T): Promise<T> {
    return this.execute((database) => {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = callback(database);
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    });
  }

  async postgresQuery<T extends QueryResultRow = QueryResultRow>(
    query: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    await this.ensureReady();
    if (!this.metaClient) {
      throw new Error('Postgres não configurado');
    }

    const result = await this.metaClient.query<T>(query, params);
    return result.rows;
  }

  async postgresTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ensureReady();
    if (!this.metaClient) {
      throw new Error('Postgres não configurado');
    }

    const client = await this.metaClient.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listIntegrationsInDatabase(): Promise<IntegrationRecord[]> {
    await this.ensureReady();
    if (!this.metaClient) {
      return structuredClone(this.metaStateCache.integrations);
    }

    const rows = await this.metaClient.query<IntegrationRow>(
      `SELECT
        id,
        name,
        graph_api_version,
        graph_api_base,
        waba_id,
        phone_number_id,
        access_token_ciphertext,
        verify_token_ciphertext,
        app_secret_ciphertext,
        client_id,
        webhook_callback_url,
        status,
        last_sync_at,
        last_healthcheck_at,
        created_at,
        updated_at
       FROM integrations
       ORDER BY created_at DESC`,
    );

    return rows.rows.map(mapIntegrationRow);
  }

  async saveIntegrationInDatabase(integration: IntegrationRecord): Promise<void> {
    await this.ensureReady();
    if (!this.metaClient) {
      await this.write((state) => {
        const index = state.integrations.findIndex((item) => item.id === integration.id);
        if (index >= 0) {
          state.integrations[index] = integration;
        } else {
          state.integrations.push(integration);
        }
      });
      return;
    }

    await this.metaClient.query(
      `INSERT INTO integrations (
        id,
        name,
        graph_api_version,
        graph_api_base,
        waba_id,
        phone_number_id,
        access_token_ciphertext,
        verify_token_ciphertext,
        app_secret_ciphertext,
        client_id,
        webhook_callback_url,
        status,
        last_sync_at,
        last_healthcheck_at,
        created_at,
        updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz,
        $14::timestamptz, $15::timestamptz, $16::timestamptz
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        graph_api_version = EXCLUDED.graph_api_version,
        graph_api_base = EXCLUDED.graph_api_base,
        waba_id = EXCLUDED.waba_id,
        phone_number_id = EXCLUDED.phone_number_id,
        access_token_ciphertext = EXCLUDED.access_token_ciphertext,
        verify_token_ciphertext = EXCLUDED.verify_token_ciphertext,
        app_secret_ciphertext = EXCLUDED.app_secret_ciphertext,
        client_id = EXCLUDED.client_id,
        webhook_callback_url = EXCLUDED.webhook_callback_url,
        status = EXCLUDED.status,
        last_sync_at = EXCLUDED.last_sync_at,
        last_healthcheck_at = EXCLUDED.last_healthcheck_at,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at`,
      [
        integration.id,
        integration.name,
        integration.graphApiVersion,
        integration.graphApiBase,
        integration.wabaId,
        integration.phoneNumberId,
        integration.accessTokenCiphertext,
        integration.verifyTokenCiphertext,
        integration.appSecretCiphertext ?? null,
        integration.clientId ?? null,
        integration.webhookCallbackUrl ?? null,
        integration.status,
        integration.lastSyncAt ?? null,
        integration.lastHealthcheckAt ?? null,
        integration.createdAt,
        integration.updatedAt,
      ],
    );

    this.metaStateCache = {
      ...this.metaStateCache,
      integrations: mergeById(this.metaStateCache.integrations, integration),
    };
  }

  async updateIntegrationTimestampsInDatabase(
    id: string,
    patch: { lastSyncAt?: string | null; lastHealthcheckAt?: string | null; updatedAt: string },
  ): Promise<void> {
    await this.ensureReady();
    if (!this.metaClient) {
      await this.write((state) => {
        const item = state.integrations.find((record) => record.id === id);
        if (!item) {
          return;
        }
        if (patch.lastSyncAt !== undefined) {
          item.lastSyncAt = patch.lastSyncAt;
        }
        if (patch.lastHealthcheckAt !== undefined) {
          item.lastHealthcheckAt = patch.lastHealthcheckAt;
        }
        item.updatedAt = patch.updatedAt;
      });
      return;
    }

    await this.metaClient.query(
      `UPDATE integrations
       SET last_sync_at = COALESCE($2::timestamptz, last_sync_at),
           last_healthcheck_at = COALESCE($3::timestamptz, last_healthcheck_at),
           updated_at = $4::timestamptz
       WHERE id = $1`,
      [id, patch.lastSyncAt ?? null, patch.lastHealthcheckAt ?? null, patch.updatedAt],
    );

    this.metaStateCache = {
      ...this.metaStateCache,
      integrations: this.metaStateCache.integrations.map((integration) =>
        integration.id === id
          ? {
              ...integration,
              lastSyncAt:
                patch.lastSyncAt !== undefined ? patch.lastSyncAt : integration.lastSyncAt ?? null,
              lastHealthcheckAt:
                patch.lastHealthcheckAt !== undefined
                  ? patch.lastHealthcheckAt
                  : integration.lastHealthcheckAt ?? null,
              updatedAt: patch.updatedAt,
            }
          : integration,
      ),
    };
  }

  /**
   * Vínculos N:N tenant <-> integração. Fonte de verdade de quem pode usar cada
   * conta WABA (ADR 0009).
   */
  async listClientIntegrationsInDatabase(): Promise<ClientIntegrationLink[]> {
    await this.ensureReady();
    if (!this.metaClient) {
      return structuredClone(this.metaStateCache.clientIntegrations);
    }

    const rows = await this.metaClient.query<ClientIntegrationRow>(
      `SELECT client_id, integration_id, created_at, created_by
       FROM integration_clients
       ORDER BY created_at ASC`,
    );

    return rows.rows.map(mapClientIntegrationRow);
  }

  /**
   * Redefine os vínculos DE UM CLIENTE, sem tocar nos vínculos dos demais.
   *
   * É o que impede o "roubo" silencioso: salvar o cliente A nunca mais remove a
   * integração compartilhada do cliente B. Remoção só acontece aqui, quando o
   * admin desmarca — e a lista enviada é sempre a do cliente em edição.
   */
  async replaceClientIntegrationsForClient(
    clientId: string,
    integrationIds: string[],
    actorId: string,
  ): Promise<void> {
    await this.ensureReady();
    const desired = [...new Set(integrationIds)];
    const createdAt = nowIso();

    if (!this.metaClient) {
      await this.write((state) => {
        const others = state.clientIntegrations.filter((link) => link.clientId !== clientId);
        const kept = state.clientIntegrations.filter(
          (link) => link.clientId === clientId && desired.includes(link.integrationId),
        );
        const keptIds = new Set(kept.map((link) => link.integrationId));
        const added = desired
          .filter((integrationId) => !keptIds.has(integrationId))
          .map((integrationId) => ({ clientId, integrationId, createdAt, createdBy: actorId }));
        state.clientIntegrations = [...others, ...kept, ...added];
        syncPrimaryClientsInState(state);
      });
      return;
    }

    const affected = await this.postgresTransaction(async (client) => {
      const before = await client.query<{ integration_id: string }>(
        'SELECT integration_id FROM integration_clients WHERE client_id = $1',
        [clientId],
      );
      await client.query(
        'DELETE FROM integration_clients WHERE client_id = $1 AND NOT (integration_id = ANY($2::text[]))',
        [clientId, desired],
      );
      for (const integrationId of desired) {
        await client.query(
          `INSERT INTO integration_clients (client_id, integration_id, created_at, created_by)
           VALUES ($1, $2, $3::timestamptz, $4)
           ON CONFLICT (client_id, integration_id) DO NOTHING`,
          [clientId, integrationId, createdAt, actorId],
        );
      }
      return [...new Set([...before.rows.map((row) => row.integration_id), ...desired])];
    });

    await this.syncIntegrationPrimaryClients(affected);
    await this.refreshClientIntegrationCache();
  }

  /** Redefine os tenants DE UMA INTEGRAÇÃO, sem tocar nas outras integrações. */
  async replaceClientsForIntegration(
    integrationId: string,
    clientIds: string[],
    actorId: string,
  ): Promise<void> {
    await this.ensureReady();
    const desired = [...new Set(clientIds)];
    const createdAt = nowIso();

    if (!this.metaClient) {
      await this.write((state) => {
        const others = state.clientIntegrations.filter(
          (link) => link.integrationId !== integrationId,
        );
        const kept = state.clientIntegrations.filter(
          (link) => link.integrationId === integrationId && desired.includes(link.clientId),
        );
        const keptIds = new Set(kept.map((link) => link.clientId));
        const added = desired
          .filter((clientId) => !keptIds.has(clientId))
          .map((clientId) => ({ clientId, integrationId, createdAt, createdBy: actorId }));
        state.clientIntegrations = [...others, ...kept, ...added];
        syncPrimaryClientsInState(state);
      });
      return;
    }

    await this.postgresTransaction(async (client) => {
      await client.query(
        'DELETE FROM integration_clients WHERE integration_id = $1 AND NOT (client_id = ANY($2::text[]))',
        [integrationId, desired],
      );
      for (const clientId of desired) {
        await client.query(
          `INSERT INTO integration_clients (client_id, integration_id, created_at, created_by)
           VALUES ($1, $2, $3::timestamptz, $4)
           ON CONFLICT (client_id, integration_id) DO NOTHING`,
          [clientId, integrationId, createdAt, actorId],
        );
      }
    });

    await this.syncIntegrationPrimaryClients([integrationId]);
    await this.refreshClientIntegrationCache();
  }

  /**
   * Mantém `integrations.client_id` (campo derivado, legado) igual ao vínculo
   * mais antigo da integração — ou NULL quando não sobra nenhum. Sem isso o
   * backfill de boot ressuscitaria um vínculo que o admin acabou de remover.
   */
  private async syncIntegrationPrimaryClients(integrationIds: string[]): Promise<void> {
    if (!this.metaClient || integrationIds.length === 0) {
      return;
    }

    await this.metaClient.query(
      `UPDATE integrations
       SET client_id = (
         SELECT link.client_id
         FROM integration_clients link
         WHERE link.integration_id = integrations.id
         ORDER BY link.created_at ASC, link.client_id ASC
         LIMIT 1
       )
       WHERE id = ANY($1::text[])`,
      [integrationIds],
    );
  }

  private async refreshClientIntegrationCache(): Promise<void> {
    if (!this.metaClient) {
      return;
    }

    const [links, integrations] = await Promise.all([
      this.metaClient.query<ClientIntegrationRow>(
        `SELECT client_id, integration_id, created_at, created_by
         FROM integration_clients
         ORDER BY created_at ASC`,
      ),
      this.metaClient.query<IntegrationRow>(
        `SELECT
          id, name, graph_api_version, graph_api_base, waba_id, phone_number_id,
          access_token_ciphertext, verify_token_ciphertext, app_secret_ciphertext,
          client_id, webhook_callback_url, status, last_sync_at, last_healthcheck_at,
          created_at, updated_at
         FROM integrations`,
      ),
    ]);

    this.metaStateCache = {
      ...this.metaStateCache,
      clientIntegrations: links.rows.map(mapClientIntegrationRow),
      integrations: integrations.rows.map(mapIntegrationRow),
    };
  }

  async listTemplatesInDatabase(integrationId?: string): Promise<TemplateCacheRecord[]> {
    await this.ensureReady();
    if (!this.metaClient) {
      return structuredClone(
        this.metaStateCache.templates.filter(
          (template) => !integrationId || template.integrationId === integrationId,
        ),
      );
    }

    const rows = await this.metaClient.query<TemplateRow>(
      `SELECT
        id,
        integration_id,
        client_id,
        meta_template_id,
        name,
        language_code,
        category,
        status,
        components_json,
        has_flow_button,
        flow_button_meta_json,
        variable_descriptors_json,
        raw_json,
        last_synced_at
       FROM templates
       WHERE ($1::text IS NULL OR integration_id = $1)
       ORDER BY last_synced_at DESC`,
      [integrationId ?? null],
    );

    return rows.rows.map(mapTemplateRow);
  }

  async replaceTemplatesInDatabase(
    integrationId: string,
    templates: TemplateCacheRecord[],
  ): Promise<void> {
    await this.ensureReady();
    if (!this.metaClient) {
      await this.write((state) => {
        // Preserva o override de tenant (`clientId`) entre sincronizações:
        // a chave estável é `metaTemplateId` (o `id` local é regerado a cada sync).
        const overrides = new Map<string, string>();
        for (const template of state.templates) {
          if (template.integrationId === integrationId && template.clientId) {
            overrides.set(template.metaTemplateId, template.clientId);
          }
        }
        state.templates = state.templates.filter((template) => template.integrationId !== integrationId);
        state.templates.push(
          ...templates.map((template) => ({
            ...template,
            clientId: overrides.get(template.metaTemplateId) ?? template.clientId ?? null,
          })),
        );
      });
      return;
    }

    const overrides = await this.postgresTransaction(async (client) => {
      // Lê os overrides de tenant antes do DELETE para não zerar a etiqueta no re-sync.
      const existing = await client.query<{ meta_template_id: string; client_id: string }>(
        'SELECT meta_template_id, client_id FROM templates WHERE integration_id = $1 AND client_id IS NOT NULL',
        [integrationId],
      );
      const overrides = new Map<string, string>(
        existing.rows.map((row) => [row.meta_template_id, row.client_id]),
      );

      await client.query('DELETE FROM templates WHERE integration_id = $1', [integrationId]);
      for (const template of templates) {
        await client.query(
          `INSERT INTO templates (
            id,
            integration_id,
            client_id,
            meta_template_id,
            name,
            language_code,
            category,
            status,
            components_json,
            has_flow_button,
            flow_button_meta_json,
            variable_descriptors_json,
            raw_json,
            last_synced_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::timestamptz
          )`,
          [
            template.id,
            template.integrationId,
            overrides.get(template.metaTemplateId) ?? template.clientId ?? null,
            template.metaTemplateId,
            template.name,
            template.languageCode,
            template.category,
            template.status,
            JSON.stringify(template.components ?? []),
            template.hasFlowButton,
            JSON.stringify(template.flowButtonMeta ?? null),
            JSON.stringify(template.variableDescriptors ?? []),
            JSON.stringify(template.raw ?? {}),
            template.lastSyncedAt,
          ],
        );
      }

      return overrides;
    });

    // Reflete no cache em memória o mesmo `client_id` efetivamente gravado.
    this.metaStateCache = {
      ...this.metaStateCache,
      templates: [
        ...this.metaStateCache.templates.filter((template) => template.integrationId !== integrationId),
        ...structuredClone(templates).map((template) => ({
          ...template,
          clientId: overrides.get(template.metaTemplateId) ?? template.clientId ?? null,
        })),
      ],
    };
  }

  async listFlowsInDatabase(integrationId?: string): Promise<FlowCacheRecord[]> {
    await this.ensureReady();
    if (!this.metaClient) {
      return structuredClone(
        this.metaStateCache.flows.filter((flow) => !integrationId || flow.integrationId === integrationId),
      );
    }

    const rows = await this.metaClient.query<FlowRow>(
      `SELECT
        id,
        integration_id,
        meta_flow_id,
        name,
        categories_json,
        status,
        json_version,
        data_api_version,
        preview_url,
        preview_expires_at,
        health_status_json,
        endpoint_uri,
        assets_json,
        completion_payload_definitions_json,
        input_field_definitions_json,
        screen_transitions_json,
        raw_json,
        last_synced_at
       FROM flows
       WHERE ($1::text IS NULL OR integration_id = $1)
       ORDER BY last_synced_at DESC`,
      [integrationId ?? null],
    );

    return rows.rows.map(mapFlowRow);
  }

  async replaceFlowsInDatabase(integrationId: string, flows: FlowCacheRecord[]): Promise<void> {
    await this.ensureReady();
    if (!this.metaClient) {
      await this.write((state) => {
        state.flows = state.flows.filter((flow) => flow.integrationId !== integrationId);
        state.flows.push(...flows);
      });
      return;
    }

    await this.postgresTransaction(async (client) => {
      await client.query('DELETE FROM flows WHERE integration_id = $1', [integrationId]);
      for (const flow of flows) {
        await client.query(
          `INSERT INTO flows (
            id,
            integration_id,
            meta_flow_id,
            name,
            categories_json,
            status,
            json_version,
            data_api_version,
            preview_url,
            preview_expires_at,
            health_status_json,
            endpoint_uri,
            assets_json,
            completion_payload_definitions_json,
            input_field_definitions_json,
            screen_transitions_json,
            raw_json,
            last_synced_at
          ) VALUES (
            $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::timestamptz, $11::jsonb, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18::timestamptz
          )`,
          [
            flow.id,
            flow.integrationId,
            flow.metaFlowId,
            flow.name,
            JSON.stringify(flow.categories ?? []),
            flow.status,
            flow.jsonVersion ?? null,
            flow.dataApiVersion ?? null,
            flow.previewUrl ?? null,
            flow.previewExpiresAt ?? null,
            JSON.stringify(flow.healthStatus ?? null),
            flow.endpointUri ?? null,
            JSON.stringify(flow.assets ?? []),
            JSON.stringify(flow.completionPayloadDefinitions ?? []),
            JSON.stringify(flow.inputFieldDefinitions ?? []),
            JSON.stringify(flow.screenTransitions ?? []),
            JSON.stringify(flow.raw ?? {}),
            flow.lastSyncedAt,
          ],
        );
      }
    });

    this.metaStateCache = {
      ...this.metaStateCache,
      flows: [
        ...this.metaStateCache.flows.filter((flow) => flow.integrationId !== integrationId),
        ...structuredClone(flows),
      ],
    };
  }

  async onModuleDestroy(): Promise<void> {
    this.database?.close();
    this.database = undefined;
    if (this.metaClient) {
      await this.metaClient.end().catch(() => undefined);
      this.metaClient = undefined;
    }
  }

  private async ensureReady(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.init();
    }

    await this.initPromise;
  }

  private async init(): Promise<void> {
    const directory = dirname(this.sqlitePath);
    await mkdir(directory, { recursive: true });
    this.database = new DatabaseSync(this.sqlitePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 32768;
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        external_ref TEXT,
        client_name TEXT,
        first_name TEXT NOT NULL,
        last_name TEXT,
        name TEXT NOT NULL,
        category TEXT,
        record_status TEXT NOT NULL,
        phone_raw TEXT NOT NULL,
        phone_e164 TEXT NOT NULL,
        phone_hash TEXT NOT NULL UNIQUE,
        email TEXT,
        attributes_json TEXT NOT NULL,
        is_valid INTEGER NOT NULL,
        validation_error TEXT,
        is_opted_out INTEGER NOT NULL,
        opted_out_at TEXT,
        opt_out_source TEXT,
        imported_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        source_type TEXT NOT NULL,
        source_file_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS list_members (
        id TEXT PRIMARY KEY,
        list_id TEXT NOT NULL,
        contact_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(list_id, contact_id)
      );
      CREATE TABLE IF NOT EXISTS imports (
        id TEXT PRIMARY KEY,
        list_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_sha256 TEXT NOT NULL,
        total_rows INTEGER NOT NULL,
        valid_rows INTEGER NOT NULL,
        invalid_rows INTEGER NOT NULL,
        duplicate_rows INTEGER NOT NULL,
        skipped_rows INTEGER NOT NULL DEFAULT 0,
        field_mapping_json TEXT,
        defaults_json TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_contacts_updated_at ON contacts(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_contacts_phone_hash ON contacts(phone_hash);
      CREATE INDEX IF NOT EXISTS idx_list_members_list_id ON list_members(list_id);
      CREATE INDEX IF NOT EXISTS idx_list_members_contact_id ON list_members(contact_id);
    `);

    if (this.postgresUrl) {
      this.metaClient = new Pool({ connectionString: this.postgresUrl });
      await this.metaClient.query(`
        CREATE TABLE IF NOT EXISTS app_state (
          id SMALLINT PRIMARY KEY CHECK (id = 1),
          state_json TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        )
      `);
      await this.metaClient.query(`
        CREATE TABLE IF NOT EXISTS integrations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          graph_api_version TEXT NOT NULL,
          graph_api_base TEXT NOT NULL,
          waba_id TEXT NOT NULL,
          phone_number_id TEXT NOT NULL,
          access_token_ciphertext TEXT NOT NULL,
          verify_token_ciphertext TEXT NOT NULL,
          app_secret_ciphertext TEXT,
          webhook_callback_url TEXT,
          status TEXT NOT NULL,
          last_sync_at TIMESTAMPTZ,
          last_healthcheck_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_waba_phone
          ON integrations (waba_id, phone_number_id);
        -- Vínculo N:N tenant <-> integração. Fonte de verdade de quem pode usar
        -- uma conta WABA. Só sai por ação explícita de admin (ADR 0009).
        -- Nome propositalmente diferente de client_integrations: aquela tabela
        -- é schema morto de uma tentativa relacional anterior (FK para a tabela
        -- clients, que o código não usa mais — os tenants vivem no blob
        -- app_state). Nada aqui a lê ou escreve.
        CREATE TABLE IF NOT EXISTS integration_clients (
          client_id TEXT NOT NULL,
          integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL,
          created_by TEXT,
          PRIMARY KEY (client_id, integration_id)
        );
        CREATE INDEX IF NOT EXISTS idx_integration_clients_integration
          ON integration_clients (integration_id);
        -- Marcador de backfills de dado que rodam UMA vez. Sem ele, um backfill
        -- idempotente ressuscitaria em todo boot vínculos que o admin removeu.
        CREATE TABLE IF NOT EXISTS schema_backfills (
          name TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL,
          details JSONB
        );
        CREATE TABLE IF NOT EXISTS templates (
          id TEXT PRIMARY KEY,
          integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
          client_id TEXT,
          meta_template_id TEXT NOT NULL,
          name TEXT NOT NULL,
          language_code TEXT NOT NULL,
          category TEXT NOT NULL,
          status TEXT NOT NULL,
          components_json JSONB NOT NULL,
          has_flow_button BOOLEAN NOT NULL,
          flow_button_meta_json JSONB,
          variable_descriptors_json JSONB NOT NULL,
          raw_json JSONB NOT NULL,
          last_synced_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_templates_integration_sync
          ON templates (integration_id, last_synced_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_integration_meta
          ON templates (integration_id, meta_template_id);
        CREATE TABLE IF NOT EXISTS flows (
          id TEXT PRIMARY KEY,
          integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
          meta_flow_id TEXT NOT NULL,
          name TEXT NOT NULL,
          categories_json JSONB NOT NULL,
          status TEXT NOT NULL,
          json_version TEXT,
          data_api_version TEXT,
          preview_url TEXT,
          preview_expires_at TIMESTAMPTZ,
          health_status_json JSONB,
          endpoint_uri TEXT,
          assets_json JSONB,
          completion_payload_definitions_json JSONB,
          input_field_definitions_json JSONB,
          screen_transitions_json JSONB,
          raw_json JSONB NOT NULL,
          last_synced_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_flows_integration_sync
          ON flows (integration_id, last_synced_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_flows_integration_meta
          ON flows (integration_id, meta_flow_id);
        CREATE TABLE IF NOT EXISTS contacts (
          id TEXT PRIMARY KEY,
          external_ref TEXT,
          client_name TEXT,
          first_name TEXT NOT NULL,
          last_name TEXT,
          name TEXT NOT NULL,
          category TEXT,
          record_status TEXT NOT NULL,
          phone_raw TEXT NOT NULL,
          phone_e164 TEXT NOT NULL,
          phone_hash TEXT NOT NULL UNIQUE,
          email TEXT,
          attributes_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          is_valid BOOLEAN NOT NULL,
          validation_error TEXT,
          is_opted_out BOOLEAN NOT NULL DEFAULT false,
          opted_out_at TIMESTAMPTZ,
          opt_out_source TEXT,
          imported_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS lists (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          source_type TEXT NOT NULL,
          source_file_path TEXT,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );
        CREATE TABLE IF NOT EXISTS list_members (
          id TEXT PRIMARY KEY,
          list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
          contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL,
          UNIQUE(list_id, contact_id)
        );
        CREATE TABLE IF NOT EXISTS imports (
          id TEXT PRIMARY KEY,
          list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
          file_name TEXT NOT NULL,
          file_sha256 TEXT NOT NULL,
          total_rows INTEGER NOT NULL,
          valid_rows INTEGER NOT NULL,
          invalid_rows INTEGER NOT NULL,
          duplicate_rows INTEGER NOT NULL,
          skipped_rows INTEGER NOT NULL DEFAULT 0,
          field_mapping_json JSONB,
          defaults_json JSONB,
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_contacts_updated_at_pg
          ON contacts(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_contacts_phone_hash_pg
          ON contacts(phone_hash);
        CREATE INDEX IF NOT EXISTS idx_list_members_list_id_pg
          ON list_members(list_id);
        CREATE INDEX IF NOT EXISTS idx_list_members_contact_id_pg
          ON list_members(contact_id);
        CREATE TABLE IF NOT EXISTS campaign_messages (
          id TEXT PRIMARY KEY,
          campaign_id TEXT NOT NULL,
          contact_id TEXT NOT NULL,
          provider_message_id TEXT,
          flow_token TEXT,
          status TEXT NOT NULL,
          next_attempt_at TIMESTAMPTZ,
          pricing_category TEXT,
          pricing_billable BOOLEAN,
          pricing_model TEXT,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          record_json JSONB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_campaign_messages_campaign_created
          ON campaign_messages (campaign_id, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_campaign_messages_dispatch
          ON campaign_messages (campaign_id, status, next_attempt_at, created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_campaign_messages_provider_message
          ON campaign_messages (provider_message_id);
        CREATE INDEX IF NOT EXISTS idx_campaign_messages_flow_token
          ON campaign_messages (flow_token);
        CREATE INDEX IF NOT EXISTS idx_campaign_messages_contact
          ON campaign_messages (contact_id);
        CREATE TABLE IF NOT EXISTS message_events (
          id TEXT PRIMARY KEY,
          campaign_message_id TEXT,
          provider_message_id TEXT,
          event_type TEXT NOT NULL,
          status TEXT,
          occurred_at TIMESTAMPTZ NOT NULL,
          received_at TIMESTAMPTZ NOT NULL,
          dedupe_key TEXT NOT NULL UNIQUE,
          record_json JSONB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_message_events_campaign_message
          ON message_events (campaign_message_id);
        CREATE INDEX IF NOT EXISTS idx_message_events_provider_message
          ON message_events (provider_message_id);
        CREATE INDEX IF NOT EXISTS idx_message_events_occurred_at
          ON message_events (occurred_at DESC);
        CREATE TABLE IF NOT EXISTS flow_responses (
          id TEXT PRIMARY KEY,
          integration_id TEXT NOT NULL,
          campaign_id TEXT,
          campaign_message_id TEXT,
          contact_id TEXT,
          template_cache_id TEXT,
          flow_cache_id TEXT,
          meta_flow_id TEXT,
          flow_token TEXT,
          provider_message_id TEXT NOT NULL,
          completed_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          record_json JSONB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_flow_responses_completed_at
          ON flow_responses (completed_at DESC);
        CREATE INDEX IF NOT EXISTS idx_flow_responses_campaign
          ON flow_responses (campaign_id);
        CREATE INDEX IF NOT EXISTS idx_flow_responses_contact
          ON flow_responses (contact_id);
        CREATE INDEX IF NOT EXISTS idx_flow_responses_flow_cache
          ON flow_responses (flow_cache_id);
        CREATE INDEX IF NOT EXISTS idx_flow_responses_provider_message
          ON flow_responses (provider_message_id);
        CREATE INDEX IF NOT EXISTS idx_flow_responses_flow_token
          ON flow_responses (flow_token);
        CREATE TABLE IF NOT EXISTS opt_outs (
          id TEXT PRIMARY KEY,
          contact_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          record_json JSONB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_opt_outs_contact
          ON opt_outs (contact_id);
        CREATE INDEX IF NOT EXISTS idx_opt_outs_created_at
          ON opt_outs (created_at DESC);
        CREATE TABLE IF NOT EXISTS audit_logs (
          id TEXT PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL,
          record_json JSONB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
          ON audit_logs (created_at DESC);
      `);
    }

    await this.migrateTenantSchema();

    const metaRow = await this.readMetaStateRow();
    const sqliteRow = metaRow
      ? undefined
      : ((this.database
          .prepare('SELECT state_json FROM app_state WHERE id = 1')
          .get() as { state_json: string } | undefined));

    if (!metaRow && !sqliteRow) {
      const initialState = await this.readLegacyState();
      this.persistRelationalState(initialState);
      if (this.metaClient) {
        await this.bootstrapPostgresOperationalCollections(initialState);
      }
      const compactedState = this.prepareStateForStorage(initialState);
      this.metaStateCache = structuredClone(compactedState);
      await this.persistMetaState(compactedState);
      await this.ensureTenantSeed();
      return;
    }

    const initialStateJson = metaRow?.stateJson ?? sqliteRow?.state_json ?? JSON.stringify(emptyState());
    const state = hydrateState(parseStateJson(initialStateJson));
    const contactsCount = Number(
      (this.database.prepare('SELECT COUNT(*) as count FROM contacts').get() as { count: number }).count,
    );

    if (
      contactsCount === 0 &&
      (state.contacts.length || state.lists.length || state.listMembers.length || state.imports.length)
    ) {
      this.persistRelationalState(state);
    }

    if (this.metaClient) {
      await this.bootstrapPostgresOperationalCollections(state);
    }

    this.metaStateCache = this.prepareStateForStorage(state);

    if (this.metaClient && !metaRow) {
      await this.persistMetaState(this.metaStateCache);
    }

    if (this.metaClient) {
      await this.bootstrapPostgresMetaCollections();
      await this.backfillClientIntegrations();
      await this.persistMetaState(this.metaStateCache);
    } else {
      this.backfillClientIntegrationsInState();
    }

    await this.ensureTenantSeed();
  }

  /**
   * Migração idempotente e não-destrutiva do modelo multi-tenant:
   * adiciona `client_id` às tabelas relacionais grandes (contacts, lists,
   * integrations, templates) sem remover dados existentes. Em `templates` a
   * coluna é um override do tenant herdado da integração. Linhas legadas ficam com
   * `client_id` nulo (escopo Collos) até serem atribuídas a um tenant.
   */
  private async migrateTenantSchema(): Promise<void> {
    const sqliteTargets = ['contacts', 'lists'];
    for (const table of sqliteTargets) {
      this.sqliteAddColumnIfMissing(table, 'client_id', 'TEXT');
    }
    this.sqliteAddColumnIfMissing('imports', 'skipped_rows', 'INTEGER NOT NULL DEFAULT 0');
    this.database!.exec(`
      CREATE INDEX IF NOT EXISTS idx_contacts_client_id ON contacts(client_id);
      CREATE INDEX IF NOT EXISTS idx_lists_client_id ON lists(client_id);
      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        client_id TEXT,
        name TEXT NOT NULL,
        token_prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        last_used_at TEXT,
        revoked_at TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_api_tokens_client ON api_tokens(client_id);
      CREATE TABLE IF NOT EXISTS transactional_dispatches (
        id TEXT PRIMARY KEY,
        client_id TEXT,
        integration_id TEXT NOT NULL,
        campaign_message_id TEXT NOT NULL,
        idempotency_key TEXT,
        callback_url TEXT,
        callback_secret TEXT,
        callback_status TEXT,
        callback_attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_transactional_dispatches_idempotency
        ON transactional_dispatches(client_id, idempotency_key);
      CREATE INDEX IF NOT EXISTS idx_transactional_dispatches_message
        ON transactional_dispatches(campaign_message_id);
      CREATE TABLE IF NOT EXISTS pricing_rates (
        id TEXT PRIMARY KEY,
        client_id TEXT,
        category TEXT NOT NULL,
        unit_price_brl REAL NOT NULL,
        effective_from TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      DROP INDEX IF EXISTS idx_pricing_rates_scope;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_rates_client_category
        ON pricing_rates(COALESCE(client_id, ''), category);
      CREATE TABLE IF NOT EXISTS report_settings (
        id TEXT PRIMARY KEY,
        client_id TEXT,
        nota_fiscal_pct REAL NOT NULL DEFAULT 10.98,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_report_settings_client
        ON report_settings(COALESCE(client_id, ''));
      CREATE TABLE IF NOT EXISTS campaign_test_sends (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        client_id TEXT,
        integration_id TEXT NOT NULL,
        phone_e164 TEXT NOT NULL,
        flow_token TEXT,
        status TEXT NOT NULL,
        provider_message_id TEXT,
        request_payload TEXT NOT NULL,
        response_payload TEXT,
        error_payload TEXT,
        flow_response_payload TEXT,
        created_by TEXT,
        responded_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_campaign_test_sends_campaign
        ON campaign_test_sends(campaign_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_test_sends_flow_token
        ON campaign_test_sends(flow_token);
    `);

    if (this.metaClient) {
      await this.metaClient.query(`
        ALTER TABLE contacts ADD COLUMN IF NOT EXISTS client_id TEXT;
        ALTER TABLE lists ADD COLUMN IF NOT EXISTS client_id TEXT;
        ALTER TABLE integrations ADD COLUMN IF NOT EXISTS client_id TEXT;
        ALTER TABLE templates ADD COLUMN IF NOT EXISTS client_id TEXT;
        CREATE INDEX IF NOT EXISTS idx_contacts_client_id ON contacts(client_id);
        CREATE INDEX IF NOT EXISTS idx_lists_client_id ON lists(client_id);
        CREATE INDEX IF NOT EXISTS idx_integrations_client_id ON integrations(client_id);
        CREATE INDEX IF NOT EXISTS idx_templates_client ON templates(client_id);
        CREATE TABLE IF NOT EXISTS api_tokens (
          id TEXT PRIMARY KEY,
          client_id TEXT,
          name TEXT NOT NULL,
          token_prefix TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          last_used_at TIMESTAMPTZ,
          revoked_at TIMESTAMPTZ,
          created_by TEXT,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_api_tokens_client ON api_tokens(client_id);
        CREATE TABLE IF NOT EXISTS transactional_dispatches (
          id TEXT PRIMARY KEY,
          client_id TEXT,
          integration_id TEXT NOT NULL,
          campaign_message_id TEXT NOT NULL,
          idempotency_key TEXT,
          callback_url TEXT,
          callback_secret TEXT,
          callback_status TEXT,
          callback_attempts INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_transactional_dispatches_idempotency
          ON transactional_dispatches(client_id, idempotency_key);
        CREATE INDEX IF NOT EXISTS idx_transactional_dispatches_message
          ON transactional_dispatches(campaign_message_id);
        ALTER TABLE campaign_messages ADD COLUMN IF NOT EXISTS pricing_category TEXT;
        ALTER TABLE campaign_messages ADD COLUMN IF NOT EXISTS pricing_billable BOOLEAN;
        ALTER TABLE campaign_messages ADD COLUMN IF NOT EXISTS pricing_model TEXT;
        CREATE INDEX IF NOT EXISTS idx_campaign_messages_pricing_category
          ON campaign_messages(pricing_category);
        CREATE TABLE IF NOT EXISTS pricing_rates (
          id TEXT PRIMARY KEY,
          client_id TEXT,
          category TEXT NOT NULL,
          unit_price_brl NUMERIC NOT NULL,
          effective_from TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );
        ALTER TABLE pricing_rates ALTER COLUMN effective_from DROP NOT NULL;
        DROP INDEX IF EXISTS idx_pricing_rates_scope;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_rates_client_category
          ON pricing_rates(COALESCE(client_id, ''), category);
        CREATE TABLE IF NOT EXISTS report_settings (
          id TEXT PRIMARY KEY,
          client_id TEXT,
          nota_fiscal_pct NUMERIC NOT NULL DEFAULT 10.98,
          updated_at TIMESTAMPTZ NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_report_settings_client
          ON report_settings(COALESCE(client_id, ''));
        CREATE TABLE IF NOT EXISTS campaign_test_sends (
          id TEXT PRIMARY KEY,
          campaign_id TEXT NOT NULL,
          client_id TEXT,
          integration_id TEXT NOT NULL,
          phone_e164 TEXT NOT NULL,
          flow_token TEXT,
          status TEXT NOT NULL,
          provider_message_id TEXT,
          request_payload JSONB NOT NULL,
          response_payload JSONB,
          error_payload JSONB,
          flow_response_payload JSONB,
          created_by TEXT,
          responded_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_campaign_test_sends_campaign
          ON campaign_test_sends(campaign_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_test_sends_flow_token
          ON campaign_test_sends(flow_token);
      `);

      // Unicidade de telefone POR TENANT: troca o UNIQUE global de phone_hash por
      // um índice único composto (client_id, phone_hash). COALESCE trata o pool
      // compartilhado (client_id nulo) como um "tenant" próprio. Idempotente e
      // não-destrutivo (a base atual está toda sob um único tenant, sem colisão).
      await this.metaClient.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_client_phone_unique
          ON contacts (COALESCE(client_id, ''), phone_hash);
        ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_phone_hash_key;
        ALTER TABLE imports ADD COLUMN IF NOT EXISTS skipped_rows INTEGER NOT NULL DEFAULT 0;
      `);

      // WABA-27: escala declarada das perguntas do flow (data-source do FLOW_JSON).
      // Coluna nova e opcional: flows já sincronizados ficam com NULL e caem no
      // fallback de escala observada até o próximo sync. Idempotente.
      await this.metaClient.query(`
        ALTER TABLE flows ADD COLUMN IF NOT EXISTS input_field_definitions_json JSONB;
        ALTER TABLE flows ADD COLUMN IF NOT EXISTS screen_transitions_json JSONB;
      `);
    }
  }

  private sqliteAddColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.database!.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (columns.some((entry) => entry.name === column)) {
      return;
    }
    this.database!.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  /**
   * Garante que exista ao menos um usuário super_admin para login,
   * derivado de ADMIN_EMAIL/ADMIN_PASSWORD. Mantém compatibilidade com o
   * fluxo de login anterior (single-admin via env). Não sobrescreve usuários
   * já existentes.
   */
  private async ensureTenantSeed(): Promise<void> {
    if (this.metaStateCache.users.length > 0) {
      return;
    }

    const timestamp = nowIso();
    const seedUser: UserRecord = {
      id: 'usr-superadmin-seed',
      clientIds: [],
      name: 'Administrador Collos',
      email: this.env.adminEmail.trim().toLowerCase(),
      passwordHash: hashPassword(this.env.adminPassword),
      role: 'super_admin',
      status: 'active',
      lastLoginAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const seededState: AppState = {
      ...structuredClone(this.metaStateCache),
      users: [seedUser],
    };
    const compactedState = this.prepareStateForStorage(seededState);
    this.metaStateCache = structuredClone(compactedState);
    await this.persistMetaState(compactedState);
  }

  private async readLegacyState(): Promise<AppState> {
    if (!existsSync(this.legacyDataFilePath)) {
      return emptyState();
    }

    try {
      const content = await readFile(this.legacyDataFilePath, 'utf8');
      return hydrateState(JSON.parse(content) as Partial<AppState>);
    } catch {
      return emptyState();
    }
  }

  private async readCurrentState(): Promise<AppState> {
    const metaState = await this.readMetaState();
    const [contacts, lists, listMembers, imports] = await Promise.all([
      this.readContacts(),
      this.readLists(),
      this.readListMembers(),
      this.readImports(),
    ]);

    return {
      ...metaState,
      contacts,
      lists,
      listMembers,
      imports,
    };
  }

  private async readMetaState(): Promise<AppState> {
    return structuredClone(this.metaStateCache);
  }

  private async readMetaStateRow(): Promise<{ stateJson: string } | undefined> {
    if (this.metaClient) {
      const result = await this.metaClient.query<{ state_json: string }>(
        'SELECT state_json FROM app_state WHERE id = 1',
      );
      const row = result.rows[0];
      return row ? { stateJson: row.state_json } : undefined;
    }

    const row = this.database!
      .prepare('SELECT state_json FROM app_state WHERE id = 1')
      .get() as { state_json: string } | undefined;
    return row ? { stateJson: row.state_json } : undefined;
  }

  private async readContacts(): Promise<ContactRecord[]> {
    if (this.metaClient) {
      const rows = await this.metaClient.query<Record<string, unknown>>(
        `SELECT
          id, external_ref, client_name, first_name, last_name, name, category, record_status,
          phone_raw, phone_e164, phone_hash, email, attributes_json, is_valid, validation_error,
          is_opted_out, opted_out_at, opt_out_source, imported_at, created_at, updated_at
         FROM contacts
         ORDER BY updated_at DESC`,
      );

      return rows.rows.map((row) =>
        hydrateContact({
          id: String(row.id),
          externalRef: normalizeOptionalString(row.external_ref),
          clientName: normalizeOptionalString(row.client_name),
          firstName: String(row.first_name),
          lastName: normalizeOptionalString(row.last_name),
          name: String(row.name),
          category: normalizeOptionalString(row.category),
          recordStatus: String(row.record_status) === 'inactive' ? 'inactive' : 'active',
          phoneRaw: String(row.phone_raw),
          phoneE164: String(row.phone_e164),
          phoneHash: String(row.phone_hash),
          email: normalizeOptionalString(row.email),
          attributes: parseJsonAttributesMap(row.attributes_json),
          isValid: Boolean(row.is_valid),
          validationError: normalizeOptionalString(row.validation_error),
          isOptedOut: Boolean(row.is_opted_out),
          optedOutAt: toIsoString(asDateValue(row.opted_out_at)),
          optOutSource: normalizeOptionalString(row.opt_out_source),
          importedAt: toIsoString(asDateValue(row.imported_at)),
          createdAt: toIsoString(asDateValue(row.created_at)) ?? new Date().toISOString(),
          updatedAt: toIsoString(asDateValue(row.updated_at)) ?? new Date().toISOString(),
        }),
      );
    }

    const rows = this.database!
      .prepare(
        `SELECT
          id, external_ref, client_name, first_name, last_name, name, category, record_status,
          phone_raw, phone_e164, phone_hash, email, attributes_json, is_valid, validation_error,
          is_opted_out, opted_out_at, opt_out_source, imported_at, created_at, updated_at
         FROM contacts
         ORDER BY updated_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) =>
      hydrateContact({
        id: String(row.id),
        externalRef: normalizeOptionalString(row.external_ref),
        clientName: normalizeOptionalString(row.client_name),
        firstName: String(row.first_name),
        lastName: normalizeOptionalString(row.last_name),
        name: String(row.name),
        category: normalizeOptionalString(row.category),
        recordStatus: String(row.record_status) === 'inactive' ? 'inactive' : 'active',
        phoneRaw: String(row.phone_raw),
        phoneE164: String(row.phone_e164),
        phoneHash: String(row.phone_hash),
        email: normalizeOptionalString(row.email),
        attributes: parseJsonAttributesMap(row.attributes_json),
        isValid: Boolean(row.is_valid),
        validationError: normalizeOptionalString(row.validation_error),
        isOptedOut: Boolean(row.is_opted_out),
        optedOutAt: normalizeOptionalString(row.opted_out_at),
        optOutSource: normalizeOptionalString(row.opt_out_source),
        importedAt: normalizeOptionalString(row.imported_at),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      }),
    );
  }

  private async readLists(): Promise<ListRecord[]> {
    if (this.metaClient) {
      const rows = await this.metaClient.query<Record<string, unknown>>(
        `SELECT id, name, description, source_type, source_file_path, created_at, updated_at
         FROM lists
         ORDER BY created_at DESC`,
      );

      return rows.rows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        description: normalizeOptionalString(row.description),
        sourceType: String(row.source_type) as ListRecord['sourceType'],
        sourceFilePath: normalizeOptionalString(row.source_file_path),
          createdAt: toIsoString(asDateValue(row.created_at)) ?? new Date().toISOString(),
          updatedAt: toIsoString(asDateValue(row.updated_at)) ?? new Date().toISOString(),
      }));
    }

    const rows = this.database!
      .prepare(
        `SELECT id, name, description, source_type, source_file_path, created_at, updated_at
         FROM lists
         ORDER BY created_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      description: normalizeOptionalString(row.description),
      sourceType: String(row.source_type) as ListRecord['sourceType'],
      sourceFilePath: normalizeOptionalString(row.source_file_path),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  private async readListMembers(): Promise<ListMemberRecord[]> {
    if (this.metaClient) {
      const rows = await this.metaClient.query<Record<string, unknown>>(
        `SELECT id, list_id, contact_id, created_at
         FROM list_members`,
      );

      return rows.rows.map((row) => ({
        id: String(row.id),
        listId: String(row.list_id),
        contactId: String(row.contact_id),
          createdAt: toIsoString(asDateValue(row.created_at)) ?? new Date().toISOString(),
      }));
    }

    const rows = this.database!
      .prepare(
        `SELECT id, list_id, contact_id, created_at
         FROM list_members`,
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      listId: String(row.list_id),
      contactId: String(row.contact_id),
      createdAt: String(row.created_at),
    }));
  }

  private async readImports(): Promise<ImportRecord[]> {
    if (this.metaClient) {
      const rows = await this.metaClient.query<Record<string, unknown>>(
        `SELECT
          id, list_id, file_name, file_sha256, total_rows, valid_rows, invalid_rows, duplicate_rows,
          skipped_rows, field_mapping_json, defaults_json, status, created_at
         FROM imports
         ORDER BY created_at DESC`,
      );

      return rows.rows.map((row) => ({
        id: String(row.id),
        listId: String(row.list_id),
        fileName: String(row.file_name),
        fileSha256: String(row.file_sha256),
        totalRows: Number(row.total_rows),
        validRows: Number(row.valid_rows),
        invalidRows: Number(row.invalid_rows),
        duplicateRows: Number(row.duplicate_rows),
        skippedRows: Number(row.skipped_rows ?? 0),
        fieldMapping: parseJsonStringMap(row.field_mapping_json),
        defaults: parseJsonStringMap(row.defaults_json),
        status: String(row.status) as ImportRecord['status'],
          createdAt: toIsoString(asDateValue(row.created_at)) ?? new Date().toISOString(),
      }));
    }

    const rows = this.database!
      .prepare(
        `SELECT
          id, list_id, file_name, file_sha256, total_rows, valid_rows, invalid_rows, duplicate_rows,
          skipped_rows, field_mapping_json, defaults_json, status, created_at
         FROM imports
         ORDER BY created_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      listId: String(row.list_id),
      fileName: String(row.file_name),
      fileSha256: String(row.file_sha256),
      totalRows: Number(row.total_rows),
      validRows: Number(row.valid_rows),
      invalidRows: Number(row.invalid_rows),
      duplicateRows: Number(row.duplicate_rows),
      skippedRows: Number(row.skipped_rows ?? 0),
      fieldMapping: parseJsonStringMap(row.field_mapping_json),
      defaults: parseJsonStringMap(row.defaults_json),
      status: String(row.status) as ImportRecord['status'],
      createdAt: String(row.created_at),
    }));
  }

  private prepareStateForStorage(state: AppState): AppState {
    const relationalState = stripRelationalState(state);
    if (!this.metaClient) {
      return compactMetaStateForStorage(relationalState);
    }

    return compactMetaStateForStorage(stripOperationalState(relationalState));
  }

  async listCampaignMessagesInDatabase(options?: {
    campaignId?: string;
    limit?: number;
    offset?: number;
  }): Promise<CampaignMessageRecord[]> {
    await this.ensureReady();
    if (!this.metaClient) {
      let items = structuredClone(this.metaStateCache.campaignMessages);
      if (options?.campaignId) {
        items = items.filter((message) => message.campaignId === options.campaignId);
      }
      items = items.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const offset = Math.max(0, Number(options?.offset ?? 0));
      const limit = options?.limit ? Math.max(1, Number(options.limit)) : undefined;
      return limit ? items.slice(offset, offset + limit) : items.slice(offset);
    }

    const params: unknown[] = [];
    const conditions: string[] = [];
    if (options?.campaignId) {
      params.push(options.campaignId);
      conditions.push(`campaign_id = $${params.length}`);
    }

    let query = `SELECT
      id,
      campaign_id,
      contact_id,
      provider_message_id,
      flow_token,
      status,
      next_attempt_at,
      pricing_category,
      pricing_billable,
      pricing_model,
      created_at,
      updated_at,
      record_json
     FROM campaign_messages`;
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ' ORDER BY created_at ASC';
    if (options?.limit) {
      params.push(Math.max(1, Number(options.limit)));
      query += ` LIMIT $${params.length}`;
    }
    if (options?.offset) {
      params.push(Math.max(0, Number(options.offset)));
      query += ` OFFSET $${params.length}`;
    }

    const rows = await this.metaClient.query<CampaignMessageRow>(query, params);
    return rows.rows.map(mapCampaignMessageRow);
  }

  async countCampaignMessagesInDatabase(campaignId?: string): Promise<number> {
    await this.ensureReady();
    if (!this.metaClient) {
      return this.metaStateCache.campaignMessages.filter(
        (message) => !campaignId || message.campaignId === campaignId,
      ).length;
    }

    const rows = await this.metaClient.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM campaign_messages
       WHERE ($1::text IS NULL OR campaign_id = $1)`,
      [campaignId ?? null],
    );

    return Number(rows.rows[0]?.count ?? '0');
  }

  async findCampaignMessageByIdInDatabase(id: string): Promise<CampaignMessageRecord | null> {
    await this.ensureReady();
    if (!this.metaClient) {
      return structuredClone(this.metaStateCache.campaignMessages.find((message) => message.id === id) ?? null);
    }

    const rows = await this.metaClient.query<CampaignMessageRow>(
      `SELECT
        id,
        campaign_id,
        contact_id,
        provider_message_id,
        flow_token,
        status,
        next_attempt_at,
        pricing_category,
        pricing_billable,
        pricing_model,
        created_at,
        updated_at,
        record_json
       FROM campaign_messages
       WHERE id = $1
       LIMIT 1`,
      [id],
    );

    return rows.rows[0] ? mapCampaignMessageRow(rows.rows[0]) : null;
  }

  async findCampaignMessageByProviderMessageIdInDatabase(
    providerMessageId: string,
  ): Promise<CampaignMessageRecord | null> {
    await this.ensureReady();
    if (!this.metaClient) {
      return structuredClone(
        this.metaStateCache.campaignMessages.find(
          (message) => message.providerMessageId === providerMessageId,
        ) ?? null,
      );
    }

    const rows = await this.metaClient.query<CampaignMessageRow>(
      `SELECT
        id,
        campaign_id,
        contact_id,
        provider_message_id,
        flow_token,
        status,
        next_attempt_at,
        pricing_category,
        pricing_billable,
        pricing_model,
        created_at,
        updated_at,
        record_json
       FROM campaign_messages
       WHERE provider_message_id = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [providerMessageId],
    );

    return rows.rows[0] ? mapCampaignMessageRow(rows.rows[0]) : null;
  }

  async findCampaignMessageByFlowTokenInDatabase(flowToken: string): Promise<CampaignMessageRecord | null> {
    await this.ensureReady();
    if (!this.metaClient) {
      return structuredClone(
        this.metaStateCache.campaignMessages.find((message) => message.flowToken === flowToken) ?? null,
      );
    }

    const rows = await this.metaClient.query<CampaignMessageRow>(
      `SELECT
        id,
        campaign_id,
        contact_id,
        provider_message_id,
        flow_token,
        status,
        next_attempt_at,
        pricing_category,
        pricing_billable,
        pricing_model,
        created_at,
        updated_at,
        record_json
       FROM campaign_messages
       WHERE flow_token = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [flowToken],
    );

    return rows.rows[0] ? mapCampaignMessageRow(rows.rows[0]) : null;
  }

  // --- Disparo transacional (API pública) ---------------------------------
  // Feature Postgres-first (como api_tokens). As LEITURAS/updates chamados no
  // caminho do webhook têm fallback no-op quando não há Postgres (SQLite/CI),
  // como os vizinhos; o INSERT (caminho de dispatch, que já exige Postgres via
  // listTemplatesInDatabase) propaga o erro em vez de descartar o registro.

  async insertTransactionalDispatch(record: TransactionalDispatchRecord): Promise<void> {
    await this.postgresQuery(
      `INSERT INTO transactional_dispatches (
        id, client_id, integration_id, campaign_message_id, idempotency_key,
        callback_url, callback_secret, callback_status, callback_attempts,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        record.id,
        record.clientId ?? null,
        record.integrationId,
        record.campaignMessageId,
        record.idempotencyKey ?? null,
        record.callbackUrl ?? null,
        record.callbackSecret ?? null,
        record.callbackStatus ?? null,
        record.callbackAttempts ?? 0,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async findTransactionalDispatchByIdempotencyKey(
    clientId: string,
    idempotencyKey: string,
  ): Promise<TransactionalDispatchRecord | null> {
    await this.ensureReady();
    // Sem Postgres (dev/CI/SQLite) o canal transacional não opera => sem replay.
    if (!this.metaClient) {
      return null;
    }
    const rows = await this.metaClient.query<Record<string, unknown>>(
      `SELECT id, client_id, integration_id, campaign_message_id, idempotency_key,
              callback_url, callback_secret, callback_status, callback_attempts,
              created_at, updated_at
       FROM transactional_dispatches
       WHERE client_id = $1 AND idempotency_key = $2
       LIMIT 1`,
      [clientId, idempotencyKey],
    );
    return rows.rows[0] ? mapTransactionalDispatchRow(rows.rows[0]) : null;
  }

  async findTransactionalDispatchByCampaignMessageId(
    campaignMessageId: string,
  ): Promise<TransactionalDispatchRecord | null> {
    await this.ensureReady();
    // Chamado no caminho crítico do webhook (handleStatus). Sem Postgres não há
    // dispatches transacionais => null (não pode 500 e travar o refresh).
    if (!this.metaClient) {
      return null;
    }
    const rows = await this.metaClient.query<Record<string, unknown>>(
      `SELECT id, client_id, integration_id, campaign_message_id, idempotency_key,
              callback_url, callback_secret, callback_status, callback_attempts,
              created_at, updated_at
       FROM transactional_dispatches
       WHERE campaign_message_id = $1
       LIMIT 1`,
      [campaignMessageId],
    );
    return rows.rows[0] ? mapTransactionalDispatchRow(rows.rows[0]) : null;
  }

  async updateTransactionalCallback(
    id: string,
    update: { status: string | null; attempts: number },
  ): Promise<void> {
    await this.ensureReady();
    if (!this.metaClient) {
      return;
    }
    await this.metaClient.query(
      `UPDATE transactional_dispatches
       SET callback_status = $1, callback_attempts = $2, updated_at = $3
       WHERE id = $4`,
      [update.status ?? null, update.attempts, nowIso(), id],
    );
  }

  async saveCampaignMessageInDatabase(message: CampaignMessageRecord): Promise<void> {
    await this.ensureReady();
    if (!this.metaClient) {
      await this.write((state) => {
        state.campaignMessages = mergeById(state.campaignMessages, message);
      });
      return;
    }

    await this.upsertCampaignMessagesBatch(this.metaClient, [message]);
  }

  /**
   * Persiste a precificação (pricing) de uma mensagem, casando por
   * `provider_message_id` (wamid). Idempotente e não-destrutivo: só grava um
   * campo se veio valor (COALESCE preserva o existente), então reprocessar o
   * mesmo webhook não apaga dados. Chamado pelo webhook de status (Rafa).
   */
  async setCampaignMessagePricing(
    providerMessageId: string,
    pricing: { category?: string | null; billable?: boolean | null; model?: string | null },
  ): Promise<void> {
    await this.ensureReady();
    const category = normalizeOptionalString(pricing.category);
    const model = normalizeOptionalString(pricing.model);
    const billable = typeof pricing.billable === 'boolean' ? pricing.billable : null;
    const wamid = providerMessageId.trim();
    if (!wamid || (category === null && model === null && billable === null)) {
      return;
    }

    if (!this.metaClient) {
      await this.write((state) => {
        for (const message of state.campaignMessages) {
          if (message.providerMessageId !== wamid) {
            continue;
          }
          if (category !== null) {
            message.pricingCategory = category;
          }
          if (billable !== null) {
            message.pricingBillable = billable;
          }
          if (model !== null) {
            message.pricingModel = model;
          }
        }
      });
      return;
    }

    await this.metaClient.query(
      `UPDATE campaign_messages
       SET pricing_category = COALESCE($2, pricing_category),
           pricing_billable = COALESCE($3::boolean, pricing_billable),
           pricing_model = COALESCE($4, pricing_model)
       WHERE provider_message_id = $1`,
      [wamid, category, billable, model],
    );
  }

  // --- Tarifas e configuração de relatórios (WABA-23) ----------------------
  // Feature Postgres-first como as demais tabelas relacionais; há fallback
  // SQLite (legado/CI) via prepared statements sobre as tabelas criadas em
  // migrateTenantSchema.

  async listPricingRates(clientScope?: string | null): Promise<PricingRateRecord[]> {
    await this.ensureReady();
    const scope = (clientScope ?? '').trim() || null;

    if (!this.metaClient) {
      const rows = this.database!
        .prepare(
          `SELECT id, client_id, category, unit_price_brl, effective_from, created_at, updated_at
           FROM pricing_rates
           ${scope === null ? '' : 'WHERE client_id = ? OR client_id IS NULL'}
           ORDER BY category ASC, client_id NULLS LAST`,
        )
        .all(...(scope === null ? [] : [scope])) as Array<Record<string, unknown>>;
      return rows.map(mapPricingRateRow);
    }

    const params: unknown[] = [];
    let where = '';
    if (scope !== null) {
      params.push(scope);
      where = 'WHERE client_id = $1 OR client_id IS NULL';
    }
    const rows = await this.metaClient.query<Record<string, unknown>>(
      `SELECT id, client_id, category, unit_price_brl, effective_from, created_at, updated_at
       FROM pricing_rates
       ${where}
       ORDER BY category ASC, client_id NULLS LAST`,
      params,
    );
    return rows.rows.map(mapPricingRateRow);
  }

  /**
   * Cria/atualiza a tarifa única de (clientId, category). Sobrescreve o valor
   * atual (upsert pelo índice único COALESCE(client_id,'') + category); não gera
   * múltiplas linhas por categoria. `id` é PK mas o conflito resolve por escopo.
   */
  async upsertPricingRate(record: {
    clientId?: string | null;
    category: string;
    unitPriceBrl: number;
  }): Promise<PricingRateRecord> {
    await this.ensureReady();
    const now = nowIso();
    const complete: PricingRateRecord = {
      id: newId(),
      clientId: (record.clientId ?? null) || null,
      category: record.category.trim().toUpperCase(),
      unitPriceBrl: record.unitPriceBrl,
      effectiveFrom: now,
      createdAt: now,
      updatedAt: now,
    };

    if (!this.metaClient) {
      this.database!
        .prepare(
          `INSERT INTO pricing_rates
             (id, client_id, category, unit_price_brl, effective_from, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (COALESCE(client_id, ''), category) DO UPDATE SET
             unit_price_brl = excluded.unit_price_brl,
             updated_at = excluded.updated_at`,
        )
        .run(
          complete.id,
          complete.clientId ?? null,
          complete.category,
          complete.unitPriceBrl,
          complete.effectiveFrom ?? null,
          complete.createdAt,
          complete.updatedAt,
        );
      return this.readPricingRate(complete.clientId ?? null, complete.category) ?? complete;
    }

    const result = await this.metaClient.query<Record<string, unknown>>(
      `INSERT INTO pricing_rates
         (id, client_id, category, unit_price_brl, effective_from, created_at, updated_at)
       VALUES ($1, $2, $3, $4::numeric, $5::timestamptz, $6::timestamptz, $7::timestamptz)
       ON CONFLICT (COALESCE(client_id, ''), category) DO UPDATE SET
         unit_price_brl = EXCLUDED.unit_price_brl,
         updated_at = EXCLUDED.updated_at
       RETURNING id, client_id, category, unit_price_brl, effective_from, created_at, updated_at`,
      [
        complete.id,
        complete.clientId,
        complete.category,
        complete.unitPriceBrl,
        complete.effectiveFrom,
        complete.createdAt,
        complete.updatedAt,
      ],
    );
    return result.rows[0] ? mapPricingRateRow(result.rows[0]) : complete;
  }

  private readPricingRate(clientId: string | null, category: string): PricingRateRecord | null {
    const row = this.database!
      .prepare(
        `SELECT id, client_id, category, unit_price_brl, effective_from, created_at, updated_at
         FROM pricing_rates
         WHERE COALESCE(client_id, '') = COALESCE(?, '') AND category = ?
         LIMIT 1`,
      )
      .get(clientId, category) as Record<string, unknown> | undefined;
    return row ? mapPricingRateRow(row) : null;
  }

  /**
   * Tarifa única para (tenant, categoria). Retorna a do tenant se existir; senão
   * a global (client_id NULL); senão null. Sem vigência por data — o valor atual
   * vale para todos os relatórios.
   */
  async resolvePricingRate(
    clientId: string | null | undefined,
    category: string,
  ): Promise<PricingRateRecord | null> {
    await this.ensureReady();
    const scope = (clientId ?? '').trim() || null;
    const cat = category.trim().toUpperCase();
    const rates = await this.listPricingRates(scope);
    const applicable = rates.filter((rate) => rate.category === cat);
    if (applicable.length === 0) {
      return null;
    }
    // Prefere a tarifa específica do tenant sobre a global (client_id NULL).
    return (
      applicable.find((rate) => scope !== null && rate.clientId === scope) ??
      applicable.find((rate) => (rate.clientId ?? null) === null) ??
      applicable[0]
    );
  }

  async getReportSettings(clientId?: string | null): Promise<ReportSettingsRecord> {
    await this.ensureReady();
    const scope = (clientId ?? '').trim() || null;

    const readRow = async (
      target: string | null,
    ): Promise<ReportSettingsRecord | null> => {
      if (!this.metaClient) {
        const row = this.database!
          .prepare(
            `SELECT client_id, nota_fiscal_pct, updated_at
             FROM report_settings
             WHERE COALESCE(client_id, '') = COALESCE(?, '')
             LIMIT 1`,
          )
          .get(target) as Record<string, unknown> | undefined;
        return row ? mapReportSettingsRow(row) : null;
      }
      const rows = await this.metaClient.query<Record<string, unknown>>(
        `SELECT client_id, nota_fiscal_pct, updated_at
         FROM report_settings
         WHERE COALESCE(client_id, '') = COALESCE($1, '')
         LIMIT 1`,
        [target],
      );
      return rows.rows[0] ? mapReportSettingsRow(rows.rows[0]) : null;
    };

    const specific = scope !== null ? await readRow(scope) : null;
    const resolved = specific ?? (await readRow(null));
    return (
      resolved ?? {
        clientId: scope,
        notaFiscalPct: DEFAULT_NOTA_FISCAL_PCT,
        updatedAt: nowIso(),
      }
    );
  }

  async upsertReportSettings(record: {
    clientId?: string | null;
    notaFiscalPct: number;
  }): Promise<ReportSettingsRecord> {
    await this.ensureReady();
    const now = nowIso();
    const scope = (record.clientId ?? null) || null;
    const complete: ReportSettingsRecord = {
      clientId: scope,
      notaFiscalPct: record.notaFiscalPct,
      updatedAt: now,
    };

    if (!this.metaClient) {
      this.database!
        .prepare(
          `INSERT INTO report_settings (id, client_id, nota_fiscal_pct, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (COALESCE(client_id, '')) DO UPDATE SET
             nota_fiscal_pct = excluded.nota_fiscal_pct,
             updated_at = excluded.updated_at`,
        )
        .run(newId(), scope, complete.notaFiscalPct, complete.updatedAt);
      return complete;
    }

    await this.metaClient.query(
      `INSERT INTO report_settings (id, client_id, nota_fiscal_pct, updated_at)
       VALUES ($1, $2, $3::numeric, $4::timestamptz)
       ON CONFLICT (COALESCE(client_id, '')) DO UPDATE SET
         nota_fiscal_pct = EXCLUDED.nota_fiscal_pct,
         updated_at = EXCLUDED.updated_at`,
      [newId(), scope, complete.notaFiscalPct, complete.updatedAt],
    );
    return complete;
  }

  async replaceCampaignMessagesForCampaignInDatabase(
    campaignId: string,
    messages: CampaignMessageRecord[],
  ): Promise<void> {
    await this.ensureReady();
    if (!this.metaClient) {
      await this.write((state) => {
        state.campaignMessages = state.campaignMessages.filter((message) => message.campaignId !== campaignId);
        state.campaignMessages.push(...messages);
      });
      return;
    }

    await this.postgresTransaction(async (client) => {
      await client.query('DELETE FROM campaign_messages WHERE campaign_id = $1', [campaignId]);
      await this.upsertCampaignMessagesBatch(client, messages);
    });
  }

  async claimDispatchBatchInDatabase(
    campaignId: string,
    batchSize: number,
    leaseUntil: string,
  ): Promise<CampaignMessageRecord[]> {
    await this.ensureReady();
    if (!this.metaClient) {
      const claimed: CampaignMessageRecord[] = [];
      await this.write((state) => {
        const candidates = state.campaignMessages
          .filter((message) => {
            if (message.campaignId !== campaignId || message.status !== 'pending') {
              return false;
            }
            if (!message.nextAttemptAt) {
              return true;
            }
            return new Date(message.nextAttemptAt).getTime() <= Date.now();
          })
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
          .slice(0, batchSize);

        for (const item of candidates) {
          item.nextAttemptAt = leaseUntil;
          item.updatedAt = new Date().toISOString();
          claimed.push(structuredClone(item));
        }
      });
      return claimed;
    }

    return this.postgresTransaction(async (client) => {
      const now = new Date().toISOString();
      const rows = await client.query<CampaignMessageRow>(
        `WITH candidates AS (
          SELECT id
          FROM campaign_messages
          WHERE campaign_id = $1
            AND status = 'pending'
            AND (next_attempt_at IS NULL OR next_attempt_at <= $2::timestamptz)
          ORDER BY created_at ASC
          LIMIT $3
          FOR UPDATE SKIP LOCKED
        )
        UPDATE campaign_messages AS target
        SET next_attempt_at = $4::timestamptz,
            updated_at = $5::timestamptz
        FROM candidates
        WHERE target.id = candidates.id
        RETURNING
          target.id,
          target.campaign_id,
          target.contact_id,
          target.provider_message_id,
          target.flow_token,
          target.status,
          target.next_attempt_at,
          target.pricing_category,
          target.pricing_billable,
          target.pricing_model,
          target.created_at,
          target.updated_at,
          target.record_json`,
        [campaignId, now, Math.max(1, batchSize), leaseUntil, now],
      );

      return rows.rows.map(mapCampaignMessageRow);
    });
  }

  async getCampaignMessageSummaryInDatabase(campaignId: string): Promise<CampaignRecord['summary']> {
    await this.ensureReady();
    const summary: CampaignRecord['summary'] = {
      total: 0,
      pending: 0,
      accepted: 0,
      sent: 0,
      delivered: 0,
      read: 0,
      failed: 0,
      skipped: 0,
    };

    if (!this.metaClient) {
      for (const message of this.metaStateCache.campaignMessages.filter((item) => item.campaignId === campaignId)) {
        summary.total += 1;
        if (message.status in summary) {
          summary[message.status as keyof typeof summary] += 1;
        }
      }
      return summary;
    }

    const rows = await this.metaClient.query<{ status: CampaignMessageRecord['status']; count: string }>(
      `SELECT status, COUNT(*)::text AS count
       FROM campaign_messages
       WHERE campaign_id = $1
       GROUP BY status`,
      [campaignId],
    );

    for (const row of rows.rows) {
      const count = Number(row.count ?? '0');
      summary.total += count;
      if (row.status in summary) {
        summary[row.status as keyof typeof summary] = count;
      }
    }

    return summary;
  }

  async hasMessageEventInDatabase(dedupeKey: string): Promise<boolean> {
    await this.ensureReady();
    if (!this.metaClient) {
      return this.metaStateCache.messageEvents.some((event) => event.dedupeKey === dedupeKey);
    }

    const rows = await this.metaClient.query<{ exists: boolean }>(
      `SELECT EXISTS(
        SELECT 1
        FROM message_events
        WHERE dedupe_key = $1
      ) AS exists`,
      [dedupeKey],
    );

    return Boolean(rows.rows[0]?.exists);
  }

  async saveMessageEventInDatabase(event: MessageEventRecord): Promise<boolean> {
    await this.ensureReady();
    if (!this.metaClient) {
      if (this.metaStateCache.messageEvents.some((item) => item.dedupeKey === event.dedupeKey)) {
        return false;
      }
      await this.write((state) => {
        state.messageEvents.push(event);
      });
      return true;
    }

    const result = await this.metaClient.query(
      `INSERT INTO message_events (
        id,
        campaign_message_id,
        provider_message_id,
        event_type,
        status,
        occurred_at,
        received_at,
        dedupe_key,
        record_json
      ) VALUES (
        $1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9::jsonb
      )
      ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        event.id,
        event.campaignMessageId ?? null,
        event.providerMessageId ?? null,
        event.eventType,
        event.status ?? null,
        event.occurredAt,
        event.receivedAt,
        event.dedupeKey,
        JSON.stringify(event),
      ],
    );

    return (result.rowCount ?? 0) > 0;
  }

  async listMessageEventsInDatabase(): Promise<MessageEventRecord[]> {
    await this.ensureReady();
    if (!this.metaClient) {
      return structuredClone(this.metaStateCache.messageEvents).sort((left, right) =>
        left.occurredAt.localeCompare(right.occurredAt),
      );
    }

    const rows = await this.metaClient.query<MessageEventRow>(
      `SELECT
        id,
        campaign_message_id,
        provider_message_id,
        event_type,
        status,
        occurred_at,
        received_at,
        dedupe_key,
        record_json
       FROM message_events
       ORDER BY occurred_at ASC`,
    );

    return rows.rows.map(mapMessageEventRow);
  }

  async saveFlowResponseInDatabase(response: FlowResponseRecord): Promise<void> {
    await this.ensureReady();
    if (!this.metaClient) {
      await this.write((state) => {
        const existing = state.flowResponses.find(
          (item) =>
            item.providerMessageId === response.providerMessageId ||
            (response.flowToken && item.flowToken === response.flowToken),
        );
        if (existing) {
          Object.assign(existing, { ...response, id: existing.id, updatedAt: new Date().toISOString() });
          return;
        }
        state.flowResponses.push(response);
      });
      return;
    }

    const existing = await this.metaClient.query<{ id: string }>(
      `SELECT id
       FROM flow_responses
       WHERE provider_message_id = $1
          OR ($2::text IS NOT NULL AND flow_token = $2)
       ORDER BY updated_at DESC
       LIMIT 1`,
      [response.providerMessageId, response.flowToken ?? null],
    );

    const record: FlowResponseRecord = existing.rows[0]
      ? { ...response, id: existing.rows[0].id, updatedAt: new Date().toISOString() }
      : response;

    await this.upsertFlowResponsesBatch(this.metaClient, [record]);
  }

  /**
   * Envios de teste de campanha. Tabela própria (não `campaign_messages`) para
   * que um teste nunca entre no funil, na taxa de entrega ou no custo da campanha.
   * Só Postgres: é recurso novo, sem equivalente no blob legado de app_state.
   */
  async saveCampaignTestSendInDatabase(record: CampaignTestSendRecord): Promise<void> {
    await this.postgresQuery(
      `INSERT INTO campaign_test_sends (
         id, campaign_id, client_id, integration_id, phone_e164, flow_token, status,
         provider_message_id, request_payload, response_payload, error_payload,
         flow_response_payload, created_by, responded_at, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         provider_message_id = EXCLUDED.provider_message_id,
         response_payload = EXCLUDED.response_payload,
         error_payload = EXCLUDED.error_payload,
         flow_response_payload = EXCLUDED.flow_response_payload,
         responded_at = EXCLUDED.responded_at,
         updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        record.campaignId,
        record.clientId ?? null,
        record.integrationId,
        record.phoneE164,
        record.flowToken ?? null,
        record.status,
        record.providerMessageId ?? null,
        JSON.stringify(record.requestPayload ?? {}),
        record.responsePayload ? JSON.stringify(record.responsePayload) : null,
        record.errorPayload ? JSON.stringify(record.errorPayload) : null,
        record.flowResponsePayload ? JSON.stringify(record.flowResponsePayload) : null,
        record.createdBy ?? null,
        record.respondedAt ?? null,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async listCampaignTestSendsInDatabase(
    campaignId: string,
    limit = 50,
  ): Promise<CampaignTestSendRecord[]> {
    const rows = await this.postgresQuery<Record<string, unknown>>(
      `SELECT * FROM campaign_test_sends
       WHERE campaign_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [campaignId, limit],
    );
    return rows.map(mapCampaignTestSendRow);
  }

  /** Casa a resposta de flow que chega no webhook com o teste que a originou. */
  async findCampaignTestSendByFlowTokenInDatabase(
    flowToken: string,
  ): Promise<CampaignTestSendRecord | null> {
    const rows = await this.postgresQuery<Record<string, unknown>>(
      `SELECT * FROM campaign_test_sends WHERE flow_token = $1 LIMIT 1`,
      [flowToken],
    );
    return rows[0] ? mapCampaignTestSendRow(rows[0]) : null;
  }

  async listFlowResponsesInDatabase(filters?: {
    campaignId?: string;
    flowCacheId?: string;
    contactId?: string;
    limit?: number;
  }): Promise<FlowResponseRecord[]> {
    await this.ensureReady();
    if (!this.metaClient) {
      let items = structuredClone(this.metaStateCache.flowResponses);
      if (filters?.campaignId) {
        items = items.filter((item) => item.campaignId === filters.campaignId);
      }
      if (filters?.flowCacheId) {
        items = items.filter((item) => item.flowCacheId === filters.flowCacheId);
      }
      if (filters?.contactId) {
        items = items.filter((item) => item.contactId === filters.contactId);
      }
      items = items.sort((left, right) => right.completedAt.localeCompare(left.completedAt));
      return items.slice(0, filters?.limit ?? items.length);
    }

    const params: unknown[] = [];
    const conditions: string[] = [];
    if (filters?.campaignId) {
      params.push(filters.campaignId);
      conditions.push(`campaign_id = $${params.length}`);
    }
    if (filters?.flowCacheId) {
      params.push(filters.flowCacheId);
      conditions.push(`flow_cache_id = $${params.length}`);
    }
    if (filters?.contactId) {
      params.push(filters.contactId);
      conditions.push(`contact_id = $${params.length}`);
    }

    let query = `SELECT
      id,
      integration_id,
      campaign_id,
      campaign_message_id,
      contact_id,
      template_cache_id,
      flow_cache_id,
      meta_flow_id,
      flow_token,
      provider_message_id,
      completed_at,
      updated_at,
      record_json
     FROM flow_responses`;
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ' ORDER BY completed_at DESC';
    if (filters?.limit) {
      params.push(Math.max(1, Number(filters.limit)));
      query += ` LIMIT $${params.length}`;
    }

    const rows = await this.metaClient.query<FlowResponseRow>(query, params);
    return rows.rows.map(mapFlowResponseRow);
  }

  async saveOptOutInDatabase(record: OptOutRecord): Promise<void> {
    await this.ensureReady();
    if (!this.metaClient) {
      await this.write((state) => {
        state.optOuts.push(record);
      });
      return;
    }

    await this.upsertOptOutsBatch(this.metaClient, [record]);
  }

  async deleteOptOutsInDatabaseByContactIds(contactIds: string[]): Promise<void> {
    await this.ensureReady();
    if (contactIds.length === 0) {
      return;
    }

    if (!this.metaClient) {
      await this.write((state) => {
        state.optOuts = state.optOuts.filter((item) => !contactIds.includes(item.contactId));
      });
      return;
    }

    await this.metaClient.query('DELETE FROM opt_outs WHERE contact_id = ANY($1::text[])', [contactIds]);
  }

  async saveAuditLogInDatabase(record: AuditLogRecord): Promise<void> {
    await this.ensureReady();
    if (!this.metaClient) {
      await this.write((state) => {
        state.auditLogs.push(record);
      });
      return;
    }

    await this.upsertAuditLogsBatch(this.metaClient, [record]);
  }

  async deleteCampaignOperationalDataInDatabase(campaignId: string): Promise<void> {
    await this.ensureReady();
    if (!this.metaClient) {
      await this.write((state) => {
        const relatedIds = new Set(
          state.campaignMessages
            .filter((message) => message.campaignId === campaignId)
            .map((message) => message.id),
        );
        state.campaignMessages = state.campaignMessages.filter((message) => message.campaignId !== campaignId);
        state.messageEvents = state.messageEvents.filter(
          (event) => !event.campaignMessageId || !relatedIds.has(event.campaignMessageId),
        );
        state.flowResponses = state.flowResponses.filter((response) => response.campaignId !== campaignId);
      });
      return;
    }

    await this.postgresTransaction(async (client) => {
      await client.query(
        `DELETE FROM message_events
         WHERE campaign_message_id IN (
           SELECT id FROM campaign_messages WHERE campaign_id = $1
         )`,
        [campaignId],
      );
      await client.query('DELETE FROM flow_responses WHERE campaign_id = $1', [campaignId]);
      await client.query('DELETE FROM campaign_messages WHERE campaign_id = $1', [campaignId]);
    });
  }

  private async persistMetaState(state: AppState): Promise<void> {
    const serializedState = JSON.stringify(compactMetaStateForStorage(state));
    const updatedAt = new Date().toISOString();

    if (this.metaClient) {
      await this.metaClient.query(
        `INSERT INTO app_state (id, state_json, updated_at)
         VALUES (1, $1, $2::timestamptz)
         ON CONFLICT (id) DO UPDATE
         SET state_json = EXCLUDED.state_json,
             updated_at = EXCLUDED.updated_at`,
        [serializedState, updatedAt],
      );
      return;
    }

    this.database!
      .prepare(
        `INSERT INTO app_state (id, state_json, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
      )
      .run(serializedState, updatedAt);
  }

  private persistRelationalState(state: AppState) {
    const normalizedState = normalizeRelationalStateForSqlite(state);
    this.database!.exec('BEGIN IMMEDIATE');
    try {
      this.database!.exec('DELETE FROM imports');
      this.database!.exec('DELETE FROM list_members');
      this.database!.exec('DELETE FROM lists');
      this.database!.exec('DELETE FROM contacts');

      const insertContact = this.database!.prepare(
        `INSERT INTO contacts (
          id, external_ref, client_name, first_name, last_name, name, category, record_status,
          phone_raw, phone_e164, phone_hash, email, attributes_json, is_valid, validation_error,
          is_opted_out, opted_out_at, opt_out_source, imported_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const contact of normalizedState.contacts) {
        insertContact.run(
          contact.id,
          contact.externalRef ?? null,
          contact.clientName ?? null,
          contact.firstName,
          contact.lastName ?? null,
          contact.name,
          contact.category ?? null,
          contact.recordStatus,
          contact.phoneRaw,
          contact.phoneE164,
          contact.phoneHash,
          contact.email ?? null,
          JSON.stringify(contact.attributes ?? {}),
          contact.isValid ? 1 : 0,
          contact.validationError ?? null,
          contact.isOptedOut ? 1 : 0,
          contact.optedOutAt ?? null,
          contact.optOutSource ?? null,
          contact.importedAt ?? null,
          contact.createdAt,
          contact.updatedAt,
        );
      }

      const insertList = this.database!.prepare(
        `INSERT INTO lists (
          id, name, description, source_type, source_file_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const list of normalizedState.lists) {
        insertList.run(
          list.id,
          list.name,
          list.description ?? null,
          list.sourceType,
          list.sourceFilePath ?? null,
          list.createdAt,
          list.updatedAt,
        );
      }

      const insertMember = this.database!.prepare(
        `INSERT INTO list_members (
          id, list_id, contact_id, created_at
        ) VALUES (?, ?, ?, ?)`,
      );
      for (const member of normalizedState.listMembers) {
        insertMember.run(member.id, member.listId, member.contactId, member.createdAt);
      }

      const insertImport = this.database!.prepare(
        `INSERT INTO imports (
          id, list_id, file_name, file_sha256, total_rows, valid_rows, invalid_rows, duplicate_rows,
          skipped_rows, field_mapping_json, defaults_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const importRecord of normalizedState.imports) {
        insertImport.run(
          importRecord.id,
          importRecord.listId,
          importRecord.fileName,
          importRecord.fileSha256,
          importRecord.totalRows,
          importRecord.validRows,
          importRecord.invalidRows,
          importRecord.duplicateRows,
          importRecord.skippedRows ?? 0,
          JSON.stringify(importRecord.fieldMapping ?? {}),
          JSON.stringify(importRecord.defaults ?? {}),
          importRecord.status,
          importRecord.createdAt,
        );
      }

      this.database!.exec('COMMIT');
    } catch (error) {
      this.database!.exec('ROLLBACK');
      throw error;
    }
  }

  private async bootstrapPostgresOperationalCollections(state: AppState): Promise<void> {
    if (!this.metaClient) {
      return;
    }

    const [
      campaignMessageCount,
      messageEventCount,
      flowResponseCount,
      optOutCount,
      auditLogCount,
    ] = await Promise.all([
      this.metaClient.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM campaign_messages'),
      this.metaClient.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM message_events'),
      this.metaClient.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM flow_responses'),
      this.metaClient.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM opt_outs'),
      this.metaClient.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM audit_logs'),
    ]);

    const client = await this.metaClient.connect();
    try {
      await client.query('BEGIN');
      if (Number(campaignMessageCount.rows[0]?.count ?? '0') === 0 && state.campaignMessages.length > 0) {
        await this.upsertCampaignMessagesBatch(client, state.campaignMessages);
      }
      if (Number(messageEventCount.rows[0]?.count ?? '0') === 0 && state.messageEvents.length > 0) {
        await this.upsertMessageEventsBatch(client, state.messageEvents);
      }
      if (Number(flowResponseCount.rows[0]?.count ?? '0') === 0 && state.flowResponses.length > 0) {
        await this.upsertFlowResponsesBatch(client, state.flowResponses);
      }
      if (Number(optOutCount.rows[0]?.count ?? '0') === 0 && state.optOuts.length > 0) {
        await this.upsertOptOutsBatch(client, state.optOuts);
      }
      if (Number(auditLogCount.rows[0]?.count ?? '0') === 0 && state.auditLogs.length > 0) {
        await this.upsertAuditLogsBatch(client, state.auditLogs);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async upsertCampaignMessagesBatch(
    client: Pool | PoolClient,
    messages: CampaignMessageRecord[],
  ): Promise<void> {
    for (const chunk of chunkArray(messages, 500)) {
      await client.query(
        `INSERT INTO campaign_messages (
          id,
          campaign_id,
          contact_id,
          provider_message_id,
          flow_token,
          status,
          next_attempt_at,
          pricing_category,
          pricing_billable,
          pricing_model,
          created_at,
          updated_at,
          record_json
        )
        SELECT
          item->>'id',
          item->>'campaignId',
          item->>'contactId',
          NULLIF(item->>'providerMessageId', ''),
          NULLIF(item->>'flowToken', ''),
          item->>'status',
          NULLIF(item->>'nextAttemptAt', '')::timestamptz,
          NULLIF(item->>'pricingCategory', ''),
          (item->>'pricingBillable')::boolean,
          NULLIF(item->>'pricingModel', ''),
          COALESCE(NULLIF(item->>'createdAt', '')::timestamptz, NOW()),
          COALESCE(NULLIF(item->>'updatedAt', '')::timestamptz, NOW()),
          item
        FROM jsonb_array_elements($1::jsonb) AS item
        ON CONFLICT (id) DO UPDATE SET
          campaign_id = EXCLUDED.campaign_id,
          contact_id = EXCLUDED.contact_id,
          provider_message_id = EXCLUDED.provider_message_id,
          flow_token = EXCLUDED.flow_token,
          status = EXCLUDED.status,
          next_attempt_at = EXCLUDED.next_attempt_at,
          -- pricing chega assíncrono pelo webhook (setCampaignMessagePricing);
          -- COALESCE evita que um re-upsert de status apague a tarifa já gravada.
          pricing_category = COALESCE(EXCLUDED.pricing_category, campaign_messages.pricing_category),
          pricing_billable = COALESCE(EXCLUDED.pricing_billable, campaign_messages.pricing_billable),
          pricing_model = COALESCE(EXCLUDED.pricing_model, campaign_messages.pricing_model),
          created_at = EXCLUDED.created_at,
          updated_at = EXCLUDED.updated_at,
          record_json = EXCLUDED.record_json`,
        [JSON.stringify(chunk)],
      );
    }
  }

  private async upsertMessageEventsBatch(
    client: Pool | PoolClient,
    events: MessageEventRecord[],
  ): Promise<void> {
    for (const chunk of chunkArray(events, 1000)) {
      await client.query(
        `INSERT INTO message_events (
          id,
          campaign_message_id,
          provider_message_id,
          event_type,
          status,
          occurred_at,
          received_at,
          dedupe_key,
          record_json
        )
        SELECT
          item->>'id',
          NULLIF(item->>'campaignMessageId', ''),
          NULLIF(item->>'providerMessageId', ''),
          item->>'eventType',
          NULLIF(item->>'status', ''),
          COALESCE(NULLIF(item->>'occurredAt', '')::timestamptz, NOW()),
          COALESCE(NULLIF(item->>'receivedAt', '')::timestamptz, NOW()),
          item->>'dedupeKey',
          item
        FROM jsonb_array_elements($1::jsonb) AS item
        ON CONFLICT (dedupe_key) DO NOTHING`,
        [JSON.stringify(chunk)],
      );
    }
  }

  private async upsertFlowResponsesBatch(
    client: Pool | PoolClient,
    responses: FlowResponseRecord[],
  ): Promise<void> {
    for (const chunk of chunkArray(responses, 500)) {
      await client.query(
        `INSERT INTO flow_responses (
          id,
          integration_id,
          campaign_id,
          campaign_message_id,
          contact_id,
          template_cache_id,
          flow_cache_id,
          meta_flow_id,
          flow_token,
          provider_message_id,
          completed_at,
          updated_at,
          record_json
        )
        SELECT
          item->>'id',
          item->>'integrationId',
          NULLIF(item->>'campaignId', ''),
          NULLIF(item->>'campaignMessageId', ''),
          NULLIF(item->>'contactId', ''),
          NULLIF(item->>'templateCacheId', ''),
          NULLIF(item->>'flowCacheId', ''),
          NULLIF(item->>'metaFlowId', ''),
          NULLIF(item->>'flowToken', ''),
          item->>'providerMessageId',
          COALESCE(NULLIF(item->>'completedAt', '')::timestamptz, NOW()),
          COALESCE(NULLIF(item->>'updatedAt', '')::timestamptz, NOW()),
          item
        FROM jsonb_array_elements($1::jsonb) AS item
        ON CONFLICT (id) DO UPDATE SET
          integration_id = EXCLUDED.integration_id,
          campaign_id = EXCLUDED.campaign_id,
          campaign_message_id = EXCLUDED.campaign_message_id,
          contact_id = EXCLUDED.contact_id,
          template_cache_id = EXCLUDED.template_cache_id,
          flow_cache_id = EXCLUDED.flow_cache_id,
          meta_flow_id = EXCLUDED.meta_flow_id,
          flow_token = EXCLUDED.flow_token,
          provider_message_id = EXCLUDED.provider_message_id,
          completed_at = EXCLUDED.completed_at,
          updated_at = EXCLUDED.updated_at,
          record_json = EXCLUDED.record_json`,
        [JSON.stringify(chunk)],
      );
    }
  }

  private async upsertOptOutsBatch(
    client: Pool | PoolClient,
    optOuts: OptOutRecord[],
  ): Promise<void> {
    for (const chunk of chunkArray(optOuts, 1000)) {
      await client.query(
        `INSERT INTO opt_outs (
          id,
          contact_id,
          created_at,
          record_json
        )
        SELECT
          item->>'id',
          item->>'contactId',
          COALESCE(NULLIF(item->>'createdAt', '')::timestamptz, NOW()),
          item
        FROM jsonb_array_elements($1::jsonb) AS item
        ON CONFLICT (id) DO UPDATE SET
          contact_id = EXCLUDED.contact_id,
          created_at = EXCLUDED.created_at,
          record_json = EXCLUDED.record_json`,
        [JSON.stringify(chunk)],
      );
    }
  }

  private async upsertAuditLogsBatch(
    client: Pool | PoolClient,
    auditLogs: AuditLogRecord[],
  ): Promise<void> {
    for (const chunk of chunkArray(auditLogs, 1000)) {
      await client.query(
        `INSERT INTO audit_logs (
          id,
          created_at,
          record_json
        )
        SELECT
          item->>'id',
          COALESCE(NULLIF(item->>'createdAt', '')::timestamptz, NOW()),
          item
        FROM jsonb_array_elements($1::jsonb) AS item
        ON CONFLICT (id) DO UPDATE SET
          created_at = EXCLUDED.created_at,
          record_json = EXCLUDED.record_json`,
        [JSON.stringify(chunk)],
      );
    }
  }


  /**
   * Equivalente do backfill para a instalação sem Postgres (blob app_state).
   * Só age em integração com `clientId` e SEM nenhum vínculo — mesma garantia
   * de não ressuscitar o que um admin removeu.
   */
  private backfillClientIntegrationsInState(): void {
    const linked = new Set(
      this.metaStateCache.clientIntegrations.map((link) => link.integrationId),
    );
    const createdAt = nowIso();
    const added = this.metaStateCache.integrations
      .filter((integration) => integration.clientId && !linked.has(integration.id))
      .map((integration) => ({
        clientId: integration.clientId as string,
        integrationId: integration.id,
        createdAt,
        createdBy: 'migration:integration_client_id',
      }));

    if (added.length === 0) {
      return;
    }

    this.metaStateCache = {
      ...this.metaStateCache,
      clientIntegrations: [...this.metaStateCache.clientIntegrations, ...added],
    };
  }

  /**
   * Popula `integration_clients` a partir do modelo antigo (1 integração = 1
   * cliente), sem nunca ressuscitar um vínculo removido por um admin.
   *
   * Duas fontes:
   * 1. `integrations.client_id` — só para integrações SEM nenhum vínculo, isto
   *    é, linhas legadas ainda não migradas. Roda em todo boot e é inócua
   *    depois da primeira vez: quem tem vínculo não é tocado, e desvincular
   *    tudo zera o `client_id` (ver `syncIntegrationPrimaryClients`).
   * 2. Campanhas já criadas — recupera os tenants que perderam o acesso no
   *    modelo exclusivo, em que atribuir a integração a um cliente a removia
   *    silenciosamente do outro. Roda UMA única vez, marcada em
   *    `schema_backfills`; sem essa trava, todo restart traria de volta
   *    vínculos que o admin tivesse acabado de remover.
   */
  private async backfillClientIntegrations(): Promise<void> {
    if (!this.metaClient) {
      return;
    }

    await this.metaClient.query(
      `INSERT INTO integration_clients (client_id, integration_id, created_at, created_by)
       SELECT integration.client_id, integration.id, NOW(), 'migration:integration_client_id'
       FROM integrations integration
       WHERE integration.client_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM integration_clients link WHERE link.integration_id = integration.id
         )
       ON CONFLICT (client_id, integration_id) DO NOTHING`,
    );

    const applied = await this.metaClient.query(
      'SELECT 1 FROM schema_backfills WHERE name = $1',
      [CAMPAIGN_LINK_BACKFILL],
    );
    if (applied.rowCount === 0) {
      const integrationIds = new Set(this.metaStateCache.integrations.map((item) => item.id));
      const clientIds = new Set(this.metaStateCache.clients.map((item) => item.id));
      const pairs = new Map<string, { clientId: string; integrationId: string }>();
      for (const campaign of this.metaStateCache.campaigns) {
        const clientId = campaign.clientId ?? null;
        if (!clientId || !clientIds.has(clientId) || !integrationIds.has(campaign.integrationId)) {
          continue;
        }
        pairs.set(`${clientId}:${campaign.integrationId}`, {
          clientId,
          integrationId: campaign.integrationId,
        });
      }

      for (const pair of pairs.values()) {
        await this.metaClient.query(
          `INSERT INTO integration_clients (client_id, integration_id, created_at, created_by)
           VALUES ($1, $2, NOW(), 'migration:campaign_history')
           ON CONFLICT (client_id, integration_id) DO NOTHING`,
          [pair.clientId, pair.integrationId],
        );
      }

      await this.metaClient.query(
        `INSERT INTO schema_backfills (name, applied_at, details)
         VALUES ($1, NOW(), $2::jsonb)
         ON CONFLICT (name) DO NOTHING`,
        [CAMPAIGN_LINK_BACKFILL, JSON.stringify({ pairs: [...pairs.values()] })],
      );
    }

    await this.syncIntegrationPrimaryClients(
      this.metaStateCache.integrations.map((integration) => integration.id),
    );
    await this.refreshClientIntegrationCache();
  }

  private async bootstrapPostgresMetaCollections(): Promise<void> {
    if (!this.metaClient) {
      return;
    }

    const [integrationCount, templateCount, flowCount] = await Promise.all([
      this.metaClient.query<{ count: string }>('SELECT COUNT(*)::text as count FROM integrations'),
      this.metaClient.query<{ count: string }>('SELECT COUNT(*)::text as count FROM templates'),
      this.metaClient.query<{ count: string }>('SELECT COUNT(*)::text as count FROM flows'),
    ]);

    if (Number(integrationCount.rows[0]?.count ?? '0') === 0 && this.metaStateCache.integrations.length > 0) {
      for (const integration of this.metaStateCache.integrations) {
        await this.metaClient.query(
          `INSERT INTO integrations (
            id,
            name,
            graph_api_version,
            graph_api_base,
            waba_id,
            phone_number_id,
            access_token_ciphertext,
            verify_token_ciphertext,
            app_secret_ciphertext,
            client_id,
            webhook_callback_url,
            status,
            last_sync_at,
            last_healthcheck_at,
            created_at,
            updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz,
            $14::timestamptz, $15::timestamptz, $16::timestamptz
          )
          ON CONFLICT (id) DO NOTHING`,
          [
            integration.id,
            integration.name,
            integration.graphApiVersion,
            integration.graphApiBase,
            integration.wabaId,
            integration.phoneNumberId,
            integration.accessTokenCiphertext,
            integration.verifyTokenCiphertext,
            integration.appSecretCiphertext ?? null,
            integration.clientId ?? null,
            integration.webhookCallbackUrl ?? null,
            integration.status,
            integration.lastSyncAt ?? null,
            integration.lastHealthcheckAt ?? null,
            integration.createdAt,
            integration.updatedAt,
          ],
        );
      }
    }

    if (Number(templateCount.rows[0]?.count ?? '0') === 0 && this.metaStateCache.templates.length > 0) {
      const templateGroups = new Map<string, TemplateCacheRecord[]>();
      for (const template of this.metaStateCache.templates) {
        const group = templateGroups.get(template.integrationId) ?? [];
        group.push(template);
        templateGroups.set(template.integrationId, group);
      }
      for (const [integrationId, templates] of templateGroups.entries()) {
        await this.metaClient.query('DELETE FROM templates WHERE integration_id = $1', [integrationId]);
        for (const template of templates) {
          await this.metaClient.query(
            `INSERT INTO templates (
              id,
              integration_id,
              client_id,
              meta_template_id,
              name,
              language_code,
              category,
              status,
              components_json,
              has_flow_button,
              flow_button_meta_json,
              variable_descriptors_json,
              raw_json,
              last_synced_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::timestamptz
            )`,
            [
              template.id,
              template.integrationId,
              template.clientId ?? null,
              template.metaTemplateId,
              template.name,
              template.languageCode,
              template.category,
              template.status,
              JSON.stringify(template.components ?? []),
              template.hasFlowButton,
              JSON.stringify(template.flowButtonMeta ?? null),
              JSON.stringify(template.variableDescriptors ?? []),
              JSON.stringify(template.raw ?? {}),
              template.lastSyncedAt,
            ],
          );
        }
      }
    }

    if (Number(flowCount.rows[0]?.count ?? '0') === 0 && this.metaStateCache.flows.length > 0) {
      const flowGroups = new Map<string, FlowCacheRecord[]>();
      for (const flow of this.metaStateCache.flows) {
        const group = flowGroups.get(flow.integrationId) ?? [];
        group.push(flow);
        flowGroups.set(flow.integrationId, group);
      }
      for (const [integrationId, flows] of flowGroups.entries()) {
        await this.metaClient.query('DELETE FROM flows WHERE integration_id = $1', [integrationId]);
        for (const flow of flows) {
          await this.metaClient.query(
            `INSERT INTO flows (
              id,
              integration_id,
              meta_flow_id,
              name,
              categories_json,
              status,
              json_version,
              data_api_version,
              preview_url,
              preview_expires_at,
              health_status_json,
              endpoint_uri,
              assets_json,
              completion_payload_definitions_json,
              input_field_definitions_json,
              screen_transitions_json,
              raw_json,
              last_synced_at
            ) VALUES (
              $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::timestamptz, $11::jsonb, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb, $17::jsonb, $18::timestamptz
            )`,
            [
              flow.id,
              flow.integrationId,
              flow.metaFlowId,
              flow.name,
              JSON.stringify(flow.categories ?? []),
              flow.status,
              flow.jsonVersion ?? null,
              flow.dataApiVersion ?? null,
              flow.previewUrl ?? null,
              flow.previewExpiresAt ?? null,
              JSON.stringify(flow.healthStatus ?? null),
              flow.endpointUri ?? null,
              JSON.stringify(flow.assets ?? []),
              JSON.stringify(flow.completionPayloadDefinitions ?? []),
              JSON.stringify(flow.inputFieldDefinitions ?? []),
              JSON.stringify(flow.screenTransitions ?? []),
              JSON.stringify(flow.raw ?? {}),
              flow.lastSyncedAt,
            ],
          );
        }
      }
    }

    const [integrationsResult, templatesResult, flowsResult, linksResult] = await Promise.all([
      this.metaClient.query<IntegrationRow>(
        `SELECT
          id,
          name,
          graph_api_version,
          graph_api_base,
          waba_id,
          phone_number_id,
          access_token_ciphertext,
          verify_token_ciphertext,
          app_secret_ciphertext,
          client_id,
          webhook_callback_url,
          status,
          last_sync_at,
          last_healthcheck_at,
          created_at,
          updated_at
         FROM integrations
         ORDER BY created_at DESC`,
      ),
      this.metaClient.query<TemplateRow>(
        `SELECT
          id,
          integration_id,
          client_id,
          meta_template_id,
          name,
          language_code,
          category,
          status,
          components_json,
          has_flow_button,
          flow_button_meta_json,
          variable_descriptors_json,
          raw_json,
          last_synced_at
         FROM templates
         ORDER BY last_synced_at DESC`,
      ),
      this.metaClient.query<FlowRow>(
        `SELECT
          id,
          integration_id,
          meta_flow_id,
          name,
          categories_json,
          status,
          json_version,
          data_api_version,
          preview_url,
          preview_expires_at,
          health_status_json,
          endpoint_uri,
          assets_json,
          completion_payload_definitions_json,
          input_field_definitions_json,
          screen_transitions_json,
          raw_json,
          last_synced_at
         FROM flows
         ORDER BY last_synced_at DESC`,
      ),
      this.metaClient.query<ClientIntegrationRow>(
        `SELECT client_id, integration_id, created_at, created_by
         FROM integration_clients
         ORDER BY created_at ASC`,
      ),
    ]);

    this.metaStateCache = {
      ...this.metaStateCache,
      integrations: integrationsResult.rows.map(mapIntegrationRow),
      templates: templatesResult.rows.map(mapTemplateRow),
      flows: flowsResult.rows.map(mapFlowRow),
      clientIntegrations: linksResult.rows.map(mapClientIntegrationRow),
    };
  }
}

type IntegrationRow = {
  id: string;
  name: string;
  graph_api_version: string;
  graph_api_base: string;
  waba_id: string;
  phone_number_id: string;
  access_token_ciphertext: string;
  verify_token_ciphertext: string;
  app_secret_ciphertext: string | null;
  client_id: string | null;
  webhook_callback_url: string | null;
  status: string;
  last_sync_at: string | Date | null;
  last_healthcheck_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type TemplateRow = {
  id: string;
  integration_id: string;
  client_id: string | null;
  meta_template_id: string;
  name: string;
  language_code: string;
  category: string;
  status: string;
  components_json: unknown;
  has_flow_button: boolean;
  flow_button_meta_json: unknown;
  variable_descriptors_json: unknown;
  raw_json: unknown;
  last_synced_at: string | Date;
};

type FlowRow = {
  id: string;
  integration_id: string;
  meta_flow_id: string;
  name: string;
  categories_json: unknown;
  status: string;
  json_version: string | null;
  data_api_version: string | null;
  preview_url: string | null;
  preview_expires_at: string | Date | null;
  health_status_json: unknown;
  endpoint_uri: string | null;
  assets_json: unknown;
  completion_payload_definitions_json: unknown;
  input_field_definitions_json: unknown;
  screen_transitions_json: unknown;
  raw_json: unknown;
  last_synced_at: string | Date;
};

type CampaignMessageRow = {
  id: string;
  campaign_id: string;
  contact_id: string;
  provider_message_id: string | null;
  flow_token: string | null;
  status: string;
  next_attempt_at: string | Date | null;
  pricing_category: string | null;
  pricing_billable: boolean | null;
  pricing_model: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  record_json: unknown;
};

type MessageEventRow = {
  id: string;
  campaign_message_id: string | null;
  provider_message_id: string | null;
  event_type: string;
  status: string | null;
  occurred_at: string | Date;
  received_at: string | Date;
  dedupe_key: string;
  record_json: unknown;
};

type FlowResponseRow = {
  id: string;
  integration_id: string;
  campaign_id: string | null;
  campaign_message_id: string | null;
  contact_id: string | null;
  template_cache_id: string | null;
  flow_cache_id: string | null;
  meta_flow_id: string | null;
  flow_token: string | null;
  provider_message_id: string;
  completed_at: string | Date;
  updated_at: string | Date;
  record_json: unknown;
};

const stripRelationalState = (state: AppState): AppState => ({
  ...state,
  contacts: [],
  lists: [],
  listMembers: [],
  imports: [],
});

const stripOperationalState = (state: AppState): AppState => ({
  ...state,
  campaignMessages: [],
  messageEvents: [],
  flowResponses: [],
  optOuts: [],
  auditLogs: [],
});

const compactMetaStateForStorage = (state: AppState): AppState => ({
  ...state,
  campaignMessages: state.campaignMessages.map(compactCampaignMessage),
  messageEvents: state.messageEvents.map(compactMessageEvent),
  flowResponses: state.flowResponses.map(compactFlowResponse),
  optOuts: state.optOuts.slice(-5_000),
  auditLogs: state.auditLogs.slice(-1_000),
});

const compactCampaignMessage = (message: CampaignMessageRecord): CampaignMessageRecord => ({
  ...message,
  payload: message.status === 'pending' || message.status === 'failed' ? message.payload : {},
});

const compactMessageEvent = (event: MessageEventRecord): MessageEventRecord => ({
  ...event,
  payload: {},
});

const compactFlowResponse = (response: FlowResponseRecord): FlowResponseRecord => ({
  ...response,
  responsePayloadRaw: null,
  rawMessage: summarizeInboundMessage(response.rawMessage),
  rawWebhook: summarizeWebhookEnvelope(response.rawWebhook),
});

const hydrateState = (state: Partial<AppState>): AppState => ({
  ...emptyState(),
  ...state,
  users: (state.users ?? []).map(hydrateUser),
  contacts: (state.contacts ?? []).map(hydrateContact),
  campaigns: (state.campaigns ?? []).map(hydrateCampaign),
});

/** Migra usuários legados de `clientId` único para `clientIds` (lista). */
const hydrateUser = (user: UserRecord): UserRecord => {
  const legacy = (user as UserRecord & { clientId?: string | null }).clientId;
  const clientIds =
    Array.isArray(user.clientIds) && user.clientIds.length > 0
      ? user.clientIds
      : legacy
        ? [legacy]
        : [];
  return { ...user, clientIds };
};

const hydrateContact = (contact: ContactRecord): ContactRecord => ({
  ...contact,
  firstName: contact.firstName ?? splitContactName(contact.name).firstName,
  lastName: contact.lastName ?? splitContactName(contact.name).lastName,
  name: buildContactName(
    contact.firstName ?? splitContactName(contact.name).firstName,
    contact.lastName ?? splitContactName(contact.name).lastName,
  ),
  clientName: contact.clientName ?? null,
  category: contact.category ?? null,
  recordStatus: contact.recordStatus ?? 'active',
  importedAt: contact.importedAt ?? contact.createdAt ?? null,
});

const splitContactName = (value: string | undefined): { firstName: string; lastName: string | null } => {
  const normalized = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return { firstName: 'Sem nome', lastName: null };
  }

  const [firstName, ...rest] = normalized.split(' ');
  return {
    firstName,
    lastName: rest.length ? rest.join(' ') : null,
  };
};

const buildContactName = (firstName: string, lastName?: string | null): string =>
  [firstName.trim(), String(lastName ?? '').trim()].filter(Boolean).join(' ').trim() || 'Sem nome';

const defaultCampaignAudience = (): CampaignAudienceConfig => ({
  mode: 'all',
  fixedCount: null,
  percentage: null,
  orderMode: 'field',
  orderField: 'importedAt',
  orderDirection: 'asc',
  resendPolicy: 'all',
  uniqueWhatsAppOnly: false,
});

const defaultCampaignAudienceSnapshot = (): CampaignAudienceSnapshot => ({
  listMembersTotal: 0,
  eligibleCount: 0,
  afterResendFilterCount: 0,
  afterUniqueWhatsAppFilterCount: 0,
  excludedByUniqueWhatsApp: 0,
  excludedByResendPolicy: 0,
  selectedCount: 0,
});

const hydrateCampaign = (campaign: CampaignRecord): CampaignRecord => ({
  ...campaign,
  audience: {
    ...defaultCampaignAudience(),
    ...(campaign.audience ?? {}),
  },
  audienceSnapshot: {
    ...defaultCampaignAudienceSnapshot(),
    ...(campaign.audienceSnapshot ?? {}),
  },
});

const normalizeOptionalString = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
};

const parseStateJson = (value: string): Partial<AppState> => {
  try {
    return JSON.parse(value) as Partial<AppState>;
  } catch {
    return emptyState();
  }
};

const parseJsonObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'string' || !value) {
    return asRecord(value) ?? {};
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const parseJsonArray = <T>(value: unknown): T[] => {
  if (Array.isArray(value)) {
    return value as T[];
  }

  if (typeof value !== 'string' || !value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
};

const toIsoString = (value: string | Date | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : String(value);
};

type ClientIntegrationRow = {
  client_id: string;
  integration_id: string;
  created_at: string | Date;
  created_by: string | null;
};

const mapClientIntegrationRow = (row: ClientIntegrationRow): ClientIntegrationLink => ({
  clientId: row.client_id,
  integrationId: row.integration_id,
  createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
  createdBy: row.created_by,
});

/**
 * Espelha, no estado em memória/blob, a mesma regra do Postgres: o `clientId`
 * da integração é o vínculo mais antigo (ou null quando não há nenhum).
 */
const syncPrimaryClientsInState = (state: AppState): void => {
  state.integrations = state.integrations.map((integration) => {
    const links = state.clientIntegrations
      .filter((link) => link.integrationId === integration.id)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.clientId.localeCompare(right.clientId),
      );
    return { ...integration, clientId: links[0]?.clientId ?? null };
  });
};

const mapIntegrationRow = (row: IntegrationRow): IntegrationRecord => ({
  id: row.id,
  name: row.name,
  graphApiVersion: row.graph_api_version,
  graphApiBase: row.graph_api_base,
  wabaId: row.waba_id,
  phoneNumberId: row.phone_number_id,
  accessTokenCiphertext: row.access_token_ciphertext,
  verifyTokenCiphertext: row.verify_token_ciphertext,
  appSecretCiphertext: row.app_secret_ciphertext,
  clientId: row.client_id ?? null,
  webhookCallbackUrl: row.webhook_callback_url,
  status: row.status === 'inactive' ? 'inactive' : 'active',
  lastSyncAt: toIsoString(row.last_sync_at),
  lastHealthcheckAt: toIsoString(row.last_healthcheck_at),
  createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
  updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
});

const mapTemplateRow = (row: TemplateRow): TemplateCacheRecord => ({
  id: row.id,
  integrationId: row.integration_id,
  clientId: row.client_id ?? null,
  metaTemplateId: row.meta_template_id,
  name: row.name,
  languageCode: row.language_code,
  category: row.category,
  status: row.status,
  components: parseJsonArray(row.components_json),
  hasFlowButton: Boolean(row.has_flow_button),
  flowButtonMeta: asRecord(row.flow_button_meta_json),
  variableDescriptors: parseJsonArray(row.variable_descriptors_json),
  raw: parseJsonObject(row.raw_json),
  lastSyncedAt: toIsoString(row.last_synced_at) ?? new Date().toISOString(),
});

const mapFlowRow = (row: FlowRow): FlowCacheRecord => ({
  id: row.id,
  integrationId: row.integration_id,
  metaFlowId: row.meta_flow_id,
  name: row.name,
  categories: parseJsonArray<string>(row.categories_json).map((value) => String(value)),
  status: row.status,
  jsonVersion: row.json_version,
  dataApiVersion: row.data_api_version,
  previewUrl: row.preview_url,
  previewExpiresAt: toIsoString(row.preview_expires_at),
  healthStatus: asRecord(row.health_status_json),
  endpointUri: row.endpoint_uri,
  assets: parseJsonArray<Record<string, unknown>>(row.assets_json),
  completionPayloadDefinitions: parseJsonArray(row.completion_payload_definitions_json),
  inputFieldDefinitions: parseJsonArray(row.input_field_definitions_json),
  screenTransitions: parseJsonArray(row.screen_transitions_json),
  raw: parseJsonObject(row.raw_json),
  lastSyncedAt: toIsoString(row.last_synced_at) ?? new Date().toISOString(),
});

const mapCampaignMessageRow = (row: CampaignMessageRow): CampaignMessageRecord => {
  const record = parseJsonObject(row.record_json) as Partial<CampaignMessageRecord>;
  return {
    id: row.id,
    campaignId: row.campaign_id,
    contactId: row.contact_id,
    phoneE164: String(record.phoneE164 ?? ''),
    status: row.status as CampaignMessageRecord['status'],
    skipReason: normalizeOptionalString(record.skipReason),
    payload: parseJsonObject(record.payload),
    payloadHash: String(record.payloadHash ?? ''),
    flowToken: row.flow_token,
    providerMessageId: row.provider_message_id,
    providerConversationId: normalizeOptionalString(record.providerConversationId),
    providerErrorCode: normalizeOptionalString(record.providerErrorCode),
    providerErrorTitle: normalizeOptionalString(record.providerErrorTitle),
    providerErrorMessage: normalizeOptionalString(record.providerErrorMessage),
    attemptCount: Number(record.attemptCount ?? 0),
    nextAttemptAt: toIsoString(row.next_attempt_at),
    lastAttemptAt: toIsoString(asDateValue(record.lastAttemptAt)),
    sentAt: toIsoString(asDateValue(record.sentAt)),
    deliveredAt: toIsoString(asDateValue(record.deliveredAt)),
    readAt: toIsoString(asDateValue(record.readAt)),
    failedAt: toIsoString(asDateValue(record.failedAt)),
    // Pricing: colunas dedicadas são a fonte de verdade; cai no record_json para
    // linhas legadas ainda não backfilladas nas colunas.
    pricingCategory: row.pricing_category ?? normalizeOptionalString(record.pricingCategory),
    pricingBillable:
      row.pricing_billable ??
      (typeof record.pricingBillable === 'boolean' ? record.pricingBillable : null),
    pricingModel: row.pricing_model ?? normalizeOptionalString(record.pricingModel),
    createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
  };
};

const mapTransactionalDispatchRow = (
  row: Record<string, unknown>,
): TransactionalDispatchRecord => ({
  id: String(row.id),
  clientId: (row.client_id as string | null) ?? null,
  integrationId: String(row.integration_id),
  campaignMessageId: String(row.campaign_message_id),
  idempotencyKey: (row.idempotency_key as string | null) ?? null,
  callbackUrl: (row.callback_url as string | null) ?? null,
  callbackSecret: (row.callback_secret as string | null) ?? null,
  callbackStatus: (row.callback_status as string | null) ?? null,
  callbackAttempts: Number(row.callback_attempts ?? 0),
  // TIMESTAMPTZ chega como Date via pg; normalizamos para ISO string.
  createdAt: toIsoString(row.created_at as string | Date | null) ?? new Date().toISOString(),
  updatedAt: toIsoString(row.updated_at as string | Date | null) ?? new Date().toISOString(),
});

const mapPricingRateRow = (row: Record<string, unknown>): PricingRateRecord => ({
  id: String(row.id),
  clientId: (row.client_id as string | null) ?? null,
  category: String(row.category),
  // NUMERIC chega como string via pg; REAL como number via sqlite.
  unitPriceBrl: Number(row.unit_price_brl),
  // Auditoria: quando a tarifa foi definida; não usado no cálculo.
  effectiveFrom: toIsoString(row.effective_from as string | Date | null),
  createdAt: toIsoString(row.created_at as string | Date | null) ?? new Date().toISOString(),
  updatedAt: toIsoString(row.updated_at as string | Date | null) ?? new Date().toISOString(),
});

const mapReportSettingsRow = (row: Record<string, unknown>): ReportSettingsRecord => ({
  clientId: (row.client_id as string | null) ?? null,
  notaFiscalPct: Number(row.nota_fiscal_pct),
  updatedAt: toIsoString(row.updated_at as string | Date | null) ?? new Date().toISOString(),
});

const mapMessageEventRow = (row: MessageEventRow): MessageEventRecord => {
  const record = parseJsonObject(row.record_json) as Partial<MessageEventRecord>;
  return {
    id: row.id,
    campaignMessageId: row.campaign_message_id,
    providerMessageId: row.provider_message_id,
    eventType: row.event_type,
    status: row.status,
    payload: parseJsonObject(record.payload),
    occurredAt: toIsoString(row.occurred_at) ?? new Date().toISOString(),
    receivedAt: toIsoString(row.received_at) ?? new Date().toISOString(),
    dedupeKey: row.dedupe_key,
  };
};

const mapCampaignTestSendRow = (row: Record<string, unknown>): CampaignTestSendRecord => {
  // Colunas JSONB voltam já desserializadas pelo pg; as demais podem vir como
  // texto (SQLite/legado), então parseJsonObject cobre os dois casos.
  const optionalJson = (value: unknown): Record<string, unknown> | null =>
    value === null || value === undefined ? null : parseJsonObject(value);

  return {
    id: String(row.id),
    campaignId: String(row.campaign_id),
    clientId: normalizeOptionalString(row.client_id),
    integrationId: String(row.integration_id),
    phoneE164: String(row.phone_e164 ?? ''),
    flowToken: normalizeOptionalString(row.flow_token),
    status: (['accepted', 'failed', 'responded'] as const).includes(
      row.status as 'accepted' | 'failed' | 'responded',
    )
      ? (row.status as 'accepted' | 'failed' | 'responded')
      : 'accepted',
    providerMessageId: normalizeOptionalString(row.provider_message_id),
    requestPayload: parseJsonObject(row.request_payload),
    responsePayload: optionalJson(row.response_payload),
    errorPayload: optionalJson(row.error_payload),
    flowResponsePayload: optionalJson(row.flow_response_payload),
    createdBy: normalizeOptionalString(row.created_by),
    respondedAt: toIsoString(row.responded_at as string | Date | null),
    createdAt: toIsoString(row.created_at as string | Date | null) ?? new Date().toISOString(),
    updatedAt: toIsoString(row.updated_at as string | Date | null) ?? new Date().toISOString(),
  };
};

const mapFlowResponseRow = (row: FlowResponseRow): FlowResponseRecord => {
  const record = parseJsonObject(row.record_json) as Partial<FlowResponseRecord>;
  return {
    id: row.id,
    integrationId: row.integration_id,
    campaignId: row.campaign_id,
    campaignMessageId: row.campaign_message_id,
    contactId: row.contact_id,
    templateCacheId: row.template_cache_id,
    flowCacheId: row.flow_cache_id,
    metaFlowId: row.meta_flow_id,
    flowToken: row.flow_token,
    providerMessageId: row.provider_message_id,
    providerContextMessageId: normalizeOptionalString(record.providerContextMessageId),
    waId: String(record.waId ?? ''),
    responsePayload: parseJsonObject(record.responsePayload),
    responsePayloadRaw: normalizeOptionalString(record.responsePayloadRaw),
    rawMessage: parseJsonObject(record.rawMessage),
    rawWebhook: parseJsonObject(record.rawWebhook),
    completedAt: toIsoString(row.completed_at) ?? new Date().toISOString(),
    createdAt: toIsoString(asDateValue(record.createdAt)) ?? toIsoString(row.completed_at) ?? new Date().toISOString(),
    updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
  };
};

const asDateValue = (value: unknown): string | Date | null => {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  return null;
};

const mergeById = <T extends { id: string }>(items: T[], next: T): T[] => {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) {
    return [structuredClone(next), ...items];
  }

  return items.map((item) => (item.id === next.id ? structuredClone(next) : item));
};

const chunkArray = <T>(items: T[], size: number): T[][] => {
  if (items.length === 0) {
    return [];
  }

  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const parseJsonStringMap = (value: unknown): Record<string, string | null> => {
  const parsed = parseJsonObject(value);
  return Object.fromEntries(
    Object.entries(parsed).map(([key, rawValue]) => {
      if (rawValue === undefined || rawValue === null) {
        return [key, null];
      }

      return [key, String(rawValue)];
    }),
  );
};

const parseJsonAttributesMap = (value: unknown): Record<string, string> => {
  const parsed = parseJsonObject(value);
  return Object.fromEntries(
    Object.entries(parsed).flatMap(([key, rawValue]) => {
      if (rawValue === undefined || rawValue === null) {
        return [];
      }

      return [[key, String(rawValue)]];
    }),
  );
};

const summarizeEventPayload = (payload: Record<string, unknown>): Record<string, unknown> => {
  const firstEntry = firstRecord(payload.entry);
  const firstChange = firstRecord(firstEntry?.changes);
  const value = asRecord(firstChange?.value);
  const firstStatus = firstRecord(value?.statuses);
  const firstMessage = firstRecord(value?.messages);
  const firstContact = firstRecord(value?.contacts);
  const firstError = firstRecord(firstStatus?.errors);

  return compactObject({
    object: normalizeScalar(payload.object),
    entryId: normalizeScalar(firstEntry?.id),
    changeField: normalizeScalar(firstChange?.field),
    messageId: normalizeScalar(firstMessage?.id ?? firstStatus?.id),
    contextId: normalizeScalar(asRecord(firstMessage?.context)?.id),
    from: normalizeScalar(firstMessage?.from ?? firstContact?.wa_id),
    type: normalizeScalar(firstMessage?.type),
    status: normalizeScalar(firstStatus?.status),
    timestamp: normalizeScalar(firstMessage?.timestamp ?? firstStatus?.timestamp),
    errorCode: normalizeScalar(firstError?.code),
    errorTitle: normalizeScalar(firstError?.title),
  });
};

const summarizeInboundMessage = (message: Record<string, unknown>): Record<string, unknown> =>
  compactObject({
    id: normalizeScalar(message.id),
    from: normalizeScalar(message.from),
    type: normalizeScalar(message.type),
    timestamp: normalizeScalar(message.timestamp),
    contextId: normalizeScalar(asRecord(message.context)?.id),
  });

const summarizeWebhookEnvelope = (payload: Record<string, unknown>): Record<string, unknown> => {
  const firstEntry = firstRecord(payload.entry);
  const firstChange = firstRecord(firstEntry?.changes);
  const value = asRecord(firstChange?.value);
  const metadata = asRecord(value?.metadata);
  const firstContact = firstRecord(value?.contacts);

  return compactObject({
    object: normalizeScalar(payload.object),
    entryId: normalizeScalar(firstEntry?.id),
    changeField: normalizeScalar(firstChange?.field),
    phoneNumberId: normalizeScalar(metadata?.phone_number_id),
    displayPhoneNumber: normalizeScalar(metadata?.display_phone_number),
    waId: normalizeScalar(firstContact?.wa_id),
  });
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const firstRecord = (value: unknown): Record<string, unknown> | null =>
  Array.isArray(value) ? asRecord(value[0]) : null;

const normalizeScalar = (value: unknown): string | number | boolean | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  return null;
};

const compactObject = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([, current]) => current !== null));

const normalizeRelationalStateForSqlite = (state: AppState): AppState => {
  const contactByPhoneHash = new Map<string, ContactRecord>();
  const contactIdRemap = new Map<string, string>();

  for (const contact of state.contacts) {
    const existing = contactByPhoneHash.get(contact.phoneHash);
    if (!existing) {
      contactByPhoneHash.set(contact.phoneHash, contact);
      contactIdRemap.set(contact.id, contact.id);
      continue;
    }

    const winner =
      contact.updatedAt.localeCompare(existing.updatedAt) >= 0 ? contact : existing;
    const loser = winner.id === contact.id ? existing : contact;
    contactByPhoneHash.set(contact.phoneHash, winner);
    contactIdRemap.set(winner.id, winner.id);
    contactIdRemap.set(loser.id, winner.id);
  }

  const contacts = Array.from(contactByPhoneHash.values());
  const lists = dedupeById(state.lists);
  const listMembers = dedupeListMembers(
    state.listMembers.map((member) => ({
      ...member,
      contactId: contactIdRemap.get(member.contactId) ?? member.contactId,
    })),
  ).filter((member) => contacts.some((contact) => contact.id === member.contactId));
  const imports = dedupeById(state.imports);

  return {
    ...state,
    contacts,
    lists,
    listMembers,
    imports,
  };
};

const dedupeById = <T extends { id: string }>(items: T[]): T[] => {
  const byId = new Map<string, T>();
  for (const item of items) {
    byId.set(item.id, item);
  }
  return Array.from(byId.values());
};

const dedupeListMembers = (items: ListMemberRecord[]): ListMemberRecord[] => {
  const byKey = new Map<string, ListMemberRecord>();
  for (const item of items) {
    byKey.set(`${item.listId}:${item.contactId}`, item);
  }
  return Array.from(byKey.values());
};
