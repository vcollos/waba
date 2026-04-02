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
  ContactRecord,
  FlowCacheRecord,
  FlowResponseRecord,
  ImportRecord,
  IntegrationRecord,
  ListMemberRecord,
  ListRecord,
  MessageEventRecord,
  OptOutRecord,
  TemplateCacheRecord,
  emptyState,
} from './types';
import { getEnv } from '../common/env';

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
        webhook_callback_url,
        status,
        last_sync_at,
        last_healthcheck_at,
        created_at,
        updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz,
        $13::timestamptz, $14::timestamptz, $15::timestamptz
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
        state.templates = state.templates.filter((template) => template.integrationId !== integrationId);
        state.templates.push(...templates);
      });
      return;
    }

    await this.postgresTransaction(async (client) => {
      await client.query('DELETE FROM templates WHERE integration_id = $1', [integrationId]);
      for (const template of templates) {
        await client.query(
          `INSERT INTO templates (
            id,
            integration_id,
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
            $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::timestamptz
          )`,
          [
            template.id,
            template.integrationId,
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
    });

    this.metaStateCache = {
      ...this.metaStateCache,
      templates: [
        ...this.metaStateCache.templates.filter((template) => template.integrationId !== integrationId),
        ...structuredClone(templates),
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
            raw_json,
            last_synced_at
          ) VALUES (
            $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::timestamptz, $11::jsonb, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16::timestamptz
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
        CREATE TABLE IF NOT EXISTS templates (
          id TEXT PRIMARY KEY,
          integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
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
      await this.persistMetaState(this.metaStateCache);
    }
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
          field_mapping_json, defaults_json, status, created_at
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
          field_mapping_json, defaults_json, status, created_at
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
          field_mapping_json, defaults_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            webhook_callback_url,
            status,
            last_sync_at,
            last_healthcheck_at,
            created_at,
            updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz,
            $13::timestamptz, $14::timestamptz, $15::timestamptz
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
              $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13::timestamptz
            )`,
            [
              template.id,
              template.integrationId,
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
              raw_json,
              last_synced_at
            ) VALUES (
              $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::timestamptz, $11::jsonb, $12, $13::jsonb, $14::jsonb, $15::jsonb, $16::timestamptz
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
              JSON.stringify(flow.raw ?? {}),
              flow.lastSyncedAt,
            ],
          );
        }
      }
    }

    const [integrationsResult, templatesResult, flowsResult] = await Promise.all([
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
          raw_json,
          last_synced_at
         FROM flows
         ORDER BY last_synced_at DESC`,
      ),
    ]);

    this.metaStateCache = {
      ...this.metaStateCache,
      integrations: integrationsResult.rows.map(mapIntegrationRow),
      templates: templatesResult.rows.map(mapTemplateRow),
      flows: flowsResult.rows.map(mapFlowRow),
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
  contacts: (state.contacts ?? []).map(hydrateContact),
  campaigns: (state.campaigns ?? []).map(hydrateCampaign),
});

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
    createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
    updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
  };
};

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
