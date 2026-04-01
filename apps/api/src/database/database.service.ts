import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import { Client } from 'pg';
import {
  AppState,
  CampaignAudienceConfig,
  CampaignAudienceSnapshot,
  CampaignMessageRecord,
  CampaignRecord,
  ContactRecord,
  FlowResponseRecord,
  ImportRecord,
  ListMemberRecord,
  ListRecord,
  MessageEventRecord,
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
  private metaClient?: Client;
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
      this.metaStateCache = stripRelationalState(structuredClone(state));
      await this.persistMetaState(stripRelationalState(state));
    });
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  async persist(state: AppState): Promise<void> {
    const task = this.queue.then(async () => {
      await this.ensureReady();
      this.persistRelationalState(state);
      this.metaStateCache = stripRelationalState(structuredClone(state));
      await this.persistMetaState(stripRelationalState(state));
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
      this.metaClient = new Client({ connectionString: this.postgresUrl });
      await this.metaClient.connect();
      await this.metaClient.query(`
        CREATE TABLE IF NOT EXISTS app_state (
          id SMALLINT PRIMARY KEY CHECK (id = 1),
          state_json TEXT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        )
      `);
    }

    const sqliteRow = this.database
      .prepare('SELECT state_json FROM app_state WHERE id = 1')
      .get() as { state_json: string } | undefined;
    const metaRow = await this.readMetaStateRow();

    if (!metaRow && !sqliteRow) {
      const initialState = await this.readLegacyState();
      this.persistRelationalState(initialState);
      this.metaStateCache = stripRelationalState(structuredClone(initialState));
      await this.persistMetaState(stripRelationalState(initialState));
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

    this.metaStateCache = stripRelationalState(state);

    if (this.metaClient && !metaRow) {
      await this.persistMetaState(stripRelationalState(state));
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

    return {
      ...metaState,
      contacts: this.readContacts(),
      lists: this.readLists(),
      listMembers: this.readListMembers(),
      imports: this.readImports(),
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

  private readContacts(): ContactRecord[] {
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

  private readLists(): ListRecord[] {
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

  private readListMembers(): ListMemberRecord[] {
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

  private readImports(): ImportRecord[] {
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
}

const stripRelationalState = (state: AppState): AppState => ({
  ...state,
  contacts: [],
  lists: [],
  listMembers: [],
  imports: [],
});

const compactMetaStateForStorage = (state: AppState): AppState => ({
  ...state,
  campaignMessages: state.campaignMessages.map(compactCampaignMessage),
  messageEvents: state.messageEvents.map(compactMessageEvent),
  flowResponses: state.flowResponses.map(compactFlowResponse),
});

const compactCampaignMessage = (message: CampaignMessageRecord): CampaignMessageRecord => ({
  ...message,
  payload:
    message.status === 'delivered' ||
    message.status === 'read' ||
    message.status === 'skipped' ||
    message.status === 'cancelled'
      ? {}
      : message.payload,
});

const compactMessageEvent = (event: MessageEventRecord): MessageEventRecord => ({
  ...event,
  payload: summarizeEventPayload(event.payload),
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
    return {};
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
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
