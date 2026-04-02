import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { PoolClient } from 'pg';
import { AuditService } from '../common/audit.service';
import { DatabaseService } from '../database/database.service';
import { hash, newId, normalizePhone, nowIso } from '../database/helpers';
import {
  ContactRecord,
  ImportRecord,
  ListMemberRecord,
  ListRecord,
  OptOutRecord,
  UserSession,
} from '../database/types';

type CsvImportField =
  | 'clientName'
  | 'firstName'
  | 'lastName'
  | 'name'
  | 'phone'
  | 'category'
  | 'status'
  | 'email'
  | 'externalRef';

type BulkAction =
  | 'activate'
  | 'deactivate'
  | 'opt_out'
  | 'opt_in'
  | 'delete'
  | 'assign_list'
  | 'set_category'
  | 'set_client';

interface ContactInput {
  clientName?: string | null;
  firstName?: string;
  lastName?: string | null;
  name?: string;
  phone?: string;
  category?: string | null;
  recordStatus?: string | null;
  email?: string | null;
  externalRef?: string | null;
  attributes?: Record<string, string>;
  listIds?: string[];
}

interface CsvImportDefaults {
  clientName?: string | null;
  category?: string | null;
  status?: string | null;
}

interface ContactsListParams {
  limit?: number;
  offset?: number;
}

interface PaginatedContactsResult {
  items: Array<ContactRecord & { listNames: string[] }>;
  total: number;
  limit: number;
  offset: number;
}

interface ListCategorySummary {
  value: string;
  label: string;
  eligibleMembers: number;
  totalMembers: number;
}

interface CsvImportJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  fileName: string;
  listName: string;
  totalRows: number;
  processedRows: number;
  createdAt: string;
  updatedAt: string;
  importRecord?: ImportRecord;
  list?: ListRecord;
  error?: string | null;
}

const IMPORTABLE_FIELDS: Array<{ key: CsvImportField; label: string; required: boolean }> = [
  { key: 'clientName', label: 'Cliente', required: false },
  { key: 'firstName', label: 'Nome', required: false },
  { key: 'lastName', label: 'Sobrenome', required: false },
  { key: 'name', label: 'Nome completo', required: false },
  { key: 'phone', label: 'Telefone', required: true },
  { key: 'category', label: 'Categoria', required: false },
  { key: 'status', label: 'Status', required: false },
  { key: 'email', label: 'E-mail', required: false },
  { key: 'externalRef', label: 'Referência externa', required: false },
];

const FIELD_ALIASES: Record<CsvImportField, string[]> = {
  clientName: ['cliente', 'client', 'empresa', 'contratante'],
  firstName: ['nome', 'primeiro_nome', 'primeiro nome', 'first_name', 'first name'],
  lastName: ['sobrenome', 'ultimo_nome', 'último nome', 'last_name', 'last name'],
  name: ['contato', 'nome_completo', 'nome completo', 'name', 'responsavel', 'titular'],
  phone: ['telefone', 'celular', 'whatsapp', 'fone', 'phone', 'mobile'],
  category: ['categoria', 'category', 'segmento', 'tag'],
  status: ['status', 'situacao', 'situação', 'ativo', 'inativo'],
  email: ['email', 'e-mail', 'mail'],
  externalRef: ['id', 'codigo', 'código', 'external_ref', 'referencia', 'referência'],
};

@Injectable()
export class ContactsService {
  private readonly importJobs = new Map<string, CsvImportJob>();

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async listContacts() {
    const rows = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT
        c.id, c.external_ref, c.client_name, c.first_name, c.last_name, c.name, c.category, c.record_status,
        c.phone_raw, c.phone_e164, c.phone_hash, c.email, c.attributes_json, c.is_valid, c.validation_error,
        c.is_opted_out, c.opted_out_at, c.opt_out_source, c.imported_at, c.created_at, c.updated_at,
        COALESCE(ARRAY_AGG(DISTINCT l.name ORDER BY l.name) FILTER (WHERE l.name IS NOT NULL), ARRAY[]::text[]) AS list_names
       FROM contacts c
       LEFT JOIN list_members lm ON lm.contact_id = c.id
       LEFT JOIN lists l ON l.id = lm.list_id
       GROUP BY c.id
       ORDER BY c.updated_at DESC`,
    );

    return rows.map((row) => ({
      ...mapContactRow(row),
      listNames: toStringArray(row.list_names),
    }));
  }

  async listContactsPage(params: ContactsListParams): Promise<PaginatedContactsResult> {
    const limit = Math.max(1, Math.min(250, Number(params.limit ?? 50)));
    const offset = Math.max(0, Number(params.offset ?? 0));
    const [{ count }] = await this.database.postgresQuery<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM contacts',
    );
    const rows = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT
        c.id, c.external_ref, c.client_name, c.first_name, c.last_name, c.name, c.category, c.record_status,
        c.phone_raw, c.phone_e164, c.phone_hash, c.email, c.attributes_json, c.is_valid, c.validation_error,
        c.is_opted_out, c.opted_out_at, c.opt_out_source, c.imported_at, c.created_at, c.updated_at,
        COALESCE(ARRAY_AGG(DISTINCT l.name ORDER BY l.name) FILTER (WHERE l.name IS NOT NULL), ARRAY[]::text[]) AS list_names
       FROM contacts c
       LEFT JOIN list_members lm ON lm.contact_id = c.id
       LEFT JOIN lists l ON l.id = lm.list_id
       GROUP BY c.id
       ORDER BY c.updated_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    return {
      items: rows.map((row) => ({
        ...mapContactRow(row),
        listNames: toStringArray(row.list_names),
      })),
      total: Number(count ?? 0),
      limit,
      offset,
    };
  }

  async listLists() {
    const rows = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT
        l.id,
        l.name,
        l.description,
        l.source_type,
        l.source_file_path,
        l.created_at,
        l.updated_at,
        COUNT(lm.contact_id)::int AS total_members,
        COUNT(*) FILTER (
          WHERE c.is_valid = true
            AND c.is_opted_out = false
            AND c.record_status = 'active'
        )::int AS eligible_members,
        COALESCE((
          SELECT jsonb_agg(
            jsonb_build_object(
              'value', category_rows.category,
              'label', category_rows.category,
              'eligibleMembers', category_rows.eligible_members,
              'totalMembers', category_rows.total_members
            )
            ORDER BY category_rows.category
          )
          FROM (
            SELECT
              NULLIF(BTRIM(c2.category), '') AS category,
              COUNT(*)::int AS total_members,
              COUNT(*) FILTER (
                WHERE c2.is_valid = true
                  AND c2.is_opted_out = false
                  AND c2.record_status = 'active'
              )::int AS eligible_members
            FROM list_members lm2
            JOIN contacts c2 ON c2.id = lm2.contact_id
            WHERE lm2.list_id = l.id
              AND NULLIF(BTRIM(c2.category), '') IS NOT NULL
            GROUP BY NULLIF(BTRIM(c2.category), '')
          ) AS category_rows
        ), '[]'::jsonb) AS category_stats
       FROM lists l
       LEFT JOIN list_members lm ON lm.list_id = l.id
       LEFT JOIN contacts c ON c.id = lm.contact_id
       GROUP BY l.id
       ORDER BY l.created_at DESC`,
    );

    return rows.map((row) => ({
      ...mapListRow(row),
      totalMembers: Number(row.total_members ?? 0),
      eligibleMembers: Number(row.eligible_members ?? 0),
      categories: parseListCategoryStats(row.category_stats),
    }));
  }

  async getList(id: string) {
    const [row] = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT id, name, description, source_type, source_file_path, created_at, updated_at
       FROM lists
       WHERE id = $1`,
      [id],
    );
    if (!row) {
      throw new NotFoundException('Lista não encontrada');
    }

    const members = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT
        c.id, c.external_ref, c.client_name, c.first_name, c.last_name, c.name, c.category, c.record_status,
        c.phone_raw, c.phone_e164, c.phone_hash, c.email, c.attributes_json, c.is_valid, c.validation_error,
        c.is_opted_out, c.opted_out_at, c.opt_out_source, c.imported_at, c.created_at, c.updated_at
       FROM list_members lm
       JOIN contacts c ON c.id = lm.contact_id
       WHERE lm.list_id = $1
       ORDER BY c.updated_at DESC`,
      [id],
    );

    return {
      ...mapListRow(row),
      members: members.map(mapContactRow),
    };
  }

  async createList(input: { name: string; description?: string }, actor: UserSession): Promise<ListRecord> {
    const timestamp = nowIso();
    const list: ListRecord = {
      id: newId(),
      name: input.name.trim() || 'Nova lista',
      description: cleanNullableText(input.description),
      sourceType: 'manual',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.database.postgresQuery(
      `INSERT INTO lists (
        id, name, description, source_type, source_file_path, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        list.id,
        list.name,
        list.description ?? null,
        list.sourceType,
        list.sourceFilePath ?? null,
        list.createdAt,
        list.updatedAt,
      ],
    );

    await this.audit.log({
      actorUserId: actor.id,
      action: 'list.created',
      entityType: 'list',
      entityId: list.id,
      metadata: { name: list.name },
    });

    return list;
  }

  async previewCsvImport(params: { fileName: string; content: Buffer }) {
    const matrix = parseCsvMatrix(params.content);
    const { headers, records } = toColumnRecords(matrix);

    return {
      fileName: params.fileName,
      headers,
      totalRows: records.length,
      sampleRows: records.slice(0, 5),
      recommendedMapping: recommendMapping(headers),
      availableFields: IMPORTABLE_FIELDS,
    };
  }

  async startCsvImport(
    params: {
      listName: string;
      fileName: string;
      content: Buffer;
      mapping?: Partial<Record<CsvImportField, string | null>>;
      defaults?: CsvImportDefaults;
    },
    actor: UserSession,
  ): Promise<CsvImportJob> {
    const matrix = parseCsvMatrix(params.content);
    const { headers, records } = toColumnRecords(matrix);
    if (records.length === 0) {
      throw new BadRequestException('CSV sem linhas para importar');
    }

    const mapping = normalizeMapping(params.mapping, headers);
    if ((!mapping.firstName && !mapping.name) || !mapping.phone) {
      throw new BadRequestException('Mapeie telefone e pelo menos nome ou nome completo antes de importar');
    }

    const defaults = normalizeImportDefaults(params.defaults);
    const jobId = newId();
    const job: CsvImportJob = {
      id: jobId,
      status: 'queued',
      fileName: params.fileName,
      listName: params.listName.trim() || params.fileName.replace(/\.[^.]+$/, ''),
      totalRows: records.length,
      processedRows: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      error: null,
    };

    this.importJobs.set(jobId, job);
    queueMicrotask(() => {
      void this.processCsvImportJob(
        jobId,
        {
          fileName: params.fileName,
          listName: job.listName,
          fileSha256: createHash('sha256').update(params.content).digest('hex'),
          records,
          mapping,
          defaults,
        },
        actor,
      );
    });

    return job;
  }

  getCsvImportJob(jobId: string): CsvImportJob {
    const job = this.importJobs.get(jobId);
    if (!job) {
      throw new NotFoundException('Importação não encontrada');
    }
    return job;
  }

  private async processCsvImportJob(
    jobId: string,
    params: {
      listName: string;
      fileName: string;
      fileSha256: string;
      records: Array<Record<string, string>>;
      mapping: Record<CsvImportField, string | null>;
      defaults: Required<CsvImportDefaults>;
    },
    actor: UserSession,
  ): Promise<void> {
    const job = this.importJobs.get(jobId);
    if (!job) {
      return;
    }

    updateImportJob(job, {
      status: 'running',
      processedRows: 0,
      updatedAt: nowIso(),
    });

    const timestamp = nowIso();
    const list: ListRecord = {
      id: newId(),
      name: params.listName.trim() || params.fileName.replace(/\.[^.]+$/, ''),
      description: `Importado de ${params.fileName}`,
      sourceType: 'csv',
      sourceFilePath: params.fileName,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    let validRows = 0;
    let invalidRows = 0;
    let duplicateRows = 0;
    try {
      await this.database.postgresQuery(
        `INSERT INTO lists (
          id, name, description, source_type, source_file_path, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          list.id,
          list.name,
          list.description ?? null,
          list.sourceType,
          list.sourceFilePath ?? null,
          list.createdAt,
          list.updatedAt,
        ],
      );

      const existingContacts = (
        await this.database.postgresQuery<Record<string, unknown>>(
          `SELECT
            id, external_ref, client_name, first_name, last_name, name, category, record_status,
            phone_raw, phone_e164, phone_hash, email, attributes_json, is_valid, validation_error,
            is_opted_out, opted_out_at, opt_out_source, imported_at, created_at, updated_at
           FROM contacts`,
        )
      ).map(mapContactRow);

      const contactsByPhoneHash = new Map(existingContacts.map((contact) => [contact.phoneHash, contact]));
      const batchContactsToInsert: ContactRecord[] = [];
      const batchContactsToUpdate: ContactRecord[] = [];
      const batchMemberships: ListMemberRecord[] = [];

      const flushBatch = async () => {
        if (
          batchContactsToInsert.length === 0 &&
          batchContactsToUpdate.length === 0 &&
          batchMemberships.length === 0
        ) {
          return;
        }

        const contactsToInsert = batchContactsToInsert.splice(0, batchContactsToInsert.length);
        const contactsToUpdate = batchContactsToUpdate.splice(0, batchContactsToUpdate.length);
        const membershipsToInsert = batchMemberships.splice(0, batchMemberships.length);

        await this.database.postgresTransaction(async (client) => {
          for (const contact of contactsToInsert) {
            await insertContactPg(client, contact);
          }

          for (const contact of contactsToUpdate) {
            await updateContactPg(client, contact);
          }

          for (const membership of membershipsToInsert) {
            await client.query(
              `INSERT INTO list_members (id, list_id, contact_id, created_at)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (list_id, contact_id) DO NOTHING`,
              [membership.id, membership.listId, membership.contactId, membership.createdAt],
            );
          }
        });
      };

      for (let index = 0; index < params.records.length; index += 1) {
        const row = params.records[index];
        const rawPhone = pickMappedValue(row, params.mapping.phone);
        const normalized = normalizePhone(rawPhone);
        const phoneHash = hash((normalized.phoneE164 || rawPhone).replace(/^\+/, ''));
        const existingContact = contactsByPhoneHash.get(phoneHash);
        const rowTimestamp = nowIso();
        const nextStatus = normalizeRecordStatus(
          pickMappedValue(row, params.mapping.status) || params.defaults.status,
        );
        const attributes = collectAttributes(row, params.mapping);

        const payload = {
          clientName:
            pickMappedValue(row, params.mapping.clientName) ||
            params.defaults.clientName ||
            existingContact?.clientName ||
            null,
          firstName:
            pickMappedValue(row, params.mapping.firstName) || existingContact?.firstName || '',
          lastName:
            pickMappedValue(row, params.mapping.lastName) || existingContact?.lastName || null,
          name: pickMappedValue(row, params.mapping.name) || existingContact?.name || 'Sem nome',
          phone: rawPhone || existingContact?.phoneRaw || '',
          category:
            pickMappedValue(row, params.mapping.category) ||
            params.defaults.category ||
            existingContact?.category ||
            null,
          email: pickMappedValue(row, params.mapping.email) || existingContact?.email || null,
          externalRef:
            pickMappedValue(row, params.mapping.externalRef) || existingContact?.externalRef || null,
          recordStatus: nextStatus,
          attributes: existingContact
            ? { ...existingContact.attributes, ...attributes }
            : attributes,
        } satisfies ContactInput & { recordStatus: string };

        const contact = existingContact
          ? updateExistingContact(existingContact, payload, normalized, rowTimestamp)
          : createNewContact(payload, normalized, rowTimestamp);

        if (existingContact) {
          duplicateRows += 1;
          batchContactsToUpdate.push(contact);
        } else {
          batchContactsToInsert.push(contact);
        }
        contactsByPhoneHash.set(contact.phoneHash, contact);
        batchMemberships.push({
          id: newId(),
          listId: list.id,
          contactId: contact.id,
          createdAt: nowIso(),
        });

        if (contact.isValid) {
          validRows += 1;
        } else {
          invalidRows += 1;
        }

        if ((index + 1) % 1000 === 0) {
          await flushBatch();
          updateImportJob(job, {
            processedRows: index + 1,
            updatedAt: nowIso(),
          });
          await yieldToEventLoop();
        }
      }

      await flushBatch();

      const importRecord: ImportRecord = {
        id: newId(),
        listId: list.id,
        fileName: params.fileName,
        fileSha256: params.fileSha256,
        totalRows: params.records.length,
        validRows,
        invalidRows,
        duplicateRows,
        fieldMapping: Object.fromEntries(
          Object.entries(params.mapping).map(([key, value]) => [key, value ?? null]),
        ),
        defaults: {
          clientName: params.defaults.clientName,
          category: params.defaults.category,
          status: params.defaults.status,
        },
        status: 'completed',
        createdAt: nowIso(),
      };

      await this.database.postgresQuery(
        `INSERT INTO imports (
          id, list_id, file_name, file_sha256, total_rows, valid_rows, invalid_rows, duplicate_rows,
          field_mapping_json, defaults_json, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
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
        ],
      );

      updateImportJob(job, {
        status: 'completed',
        processedRows: params.records.length,
        importRecord,
        list,
        updatedAt: nowIso(),
      });

      try {
        await this.audit.log({
          actorUserId: actor.id,
          action: 'contacts.imported_csv',
          entityType: 'list',
          entityId: list.id,
          metadata: {
            fileName: params.fileName,
            totalRows: params.records.length,
            validRows,
            invalidRows,
            duplicateRows,
            mapping: params.mapping,
            defaults: params.defaults,
          },
        });
      } catch {
        // Import completion must not be blocked by meta-state audit persistence.
      }
    } catch (error) {
      updateImportJob(job, {
        status: 'failed',
        error: error instanceof Error ? error.message : 'Falha ao importar CSV',
        updatedAt: nowIso(),
      });
    }
  }

  async createContact(input: ContactInput, actor: UserSession) {
    const timestamp = nowIso();
    const normalized = normalizePhone(String(input.phone ?? ''));
    const contact = createNewContact(input, normalized, timestamp);

    await this.database.postgresTransaction(async (client) => {
      await ensurePhoneIsUniqueInDatabase(client, contact.phoneHash);
      await ensureListIdsExistInDatabase(client, input.listIds);
      await insertContactPg(client, contact);
      for (const listId of input.listIds ?? []) {
        await client.query(
          `INSERT INTO list_members (id, list_id, contact_id, created_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (list_id, contact_id) DO NOTHING`,
          [newId(), listId, contact.id, nowIso()],
        );
      }
    });

    await this.audit.log({
      actorUserId: actor.id,
      action: 'contact.created',
      entityType: 'contact',
      entityId: contact.id,
      metadata: {
        clientName: contact.clientName,
        category: contact.category,
        recordStatus: contact.recordStatus,
      },
    });

    return contact;
  }

  async updateContact(id: string, input: ContactInput, actor: UserSession) {
    let updatedContact: ContactRecord | undefined;

    await this.database.postgresTransaction(async (client) => {
      const existing = await getContactByIdFromDatabase(client, id);
      if (!existing) {
        throw new NotFoundException('Contato não encontrado');
      }

      const normalized = normalizePhone(String(input.phone ?? existing.phoneRaw));
      const nextPhoneHash = hash((normalized.phoneE164 || existing.phoneE164).replace(/^\+/, ''));
      await ensurePhoneIsUniqueInDatabase(client, nextPhoneHash, id);

      updatedContact = updateExistingContact(
        existing,
        {
          clientName: input.clientName ?? existing.clientName,
          firstName: input.firstName ?? existing.firstName,
          lastName: input.lastName ?? existing.lastName,
          name: input.name ?? existing.name,
          phone: input.phone ?? existing.phoneRaw,
          category: input.category ?? existing.category,
          email: input.email ?? existing.email,
          externalRef: input.externalRef ?? existing.externalRef,
          recordStatus: input.recordStatus ?? existing.recordStatus,
          attributes:
            input.attributes && Object.keys(input.attributes).length > 0
              ? { ...existing.attributes, ...input.attributes }
              : existing.attributes,
        },
        normalized,
        nowIso(),
      );

      await updateContactPg(client, updatedContact);

      if (input.listIds) {
        await ensureListIdsExistInDatabase(client, input.listIds);
        await client.query('DELETE FROM list_members WHERE contact_id = $1', [id]);
        for (const listId of input.listIds) {
          await client.query(
            `INSERT INTO list_members (id, list_id, contact_id, created_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (list_id, contact_id) DO NOTHING`,
            [newId(), listId, id, nowIso()],
          );
        }
      }
    });

    await this.audit.log({
      actorUserId: actor.id,
      action: 'contact.updated',
      entityType: 'contact',
      entityId: id,
      metadata: {
        clientName: updatedContact?.clientName,
        category: updatedContact?.category,
        recordStatus: updatedContact?.recordStatus,
      },
    });

    return updatedContact;
  }

  async deleteContact(id: string, actor: UserSession) {
    await this.database.postgresTransaction(async (client) => {
      const existing = await getContactByIdFromDatabase(client, id);
      if (!existing) {
        throw new NotFoundException('Contato não encontrado');
      }
      await client.query('DELETE FROM list_members WHERE contact_id = $1', [id]);
      await client.query('DELETE FROM contacts WHERE id = $1', [id]);
    });

    await this.database.deleteOptOutsInDatabaseByContactIds([id]);

    await this.audit.log({
      actorUserId: actor.id,
      action: 'contact.deleted',
      entityType: 'contact',
      entityId: id,
    });

    return { deleted: true };
  }

  async bulkAction(
    input: {
      action: BulkAction;
      contactIds: string[];
      listId?: string;
      category?: string | null;
      clientName?: string | null;
    },
    actor: UserSession,
  ) {
    const contactIds = [...new Set(input.contactIds.filter(Boolean))];
    if (contactIds.length === 0) {
      throw new BadRequestException('Selecione pelo menos um contato');
    }

    let affected = 0;
    let matchedContactIds: string[] = [];

    await this.database.postgresTransaction(async (client) => {
      const existingIds = await selectExistingContactIds(client, contactIds);
      if (existingIds.length === 0) {
        throw new NotFoundException('Nenhum contato encontrado');
      }

      matchedContactIds = existingIds;
      affected = existingIds.length;
      const timestamp = nowIso();

      if (input.action === 'assign_list') {
        if (!input.listId) {
          throw new BadRequestException('Informe a lista para vincular');
        }
        await ensureListIdsExistInDatabase(client, [input.listId]);
      }

      switch (input.action) {
        case 'activate':
          await client.query(
            `UPDATE contacts SET record_status = 'active', updated_at = $1 WHERE id = ANY($2::text[])`,
            [timestamp, existingIds],
          );
          break;
        case 'deactivate':
          await client.query(
            `UPDATE contacts SET record_status = 'inactive', updated_at = $1 WHERE id = ANY($2::text[])`,
            [timestamp, existingIds],
          );
          break;
        case 'opt_out':
          await client.query(
            `UPDATE contacts
             SET is_opted_out = true, opted_out_at = $1, opt_out_source = 'manual', updated_at = $2
             WHERE id = ANY($3::text[])`,
            [timestamp, timestamp, existingIds],
          );
          break;
        case 'opt_in':
          await client.query(
            `UPDATE contacts
             SET is_opted_out = false, opted_out_at = NULL, opt_out_source = NULL, updated_at = $1
             WHERE id = ANY($2::text[])`,
            [timestamp, existingIds],
          );
          break;
        case 'assign_list': {
          for (const contactId of existingIds) {
            await client.query(
              `INSERT INTO list_members (id, list_id, contact_id, created_at)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (list_id, contact_id) DO NOTHING`,
              [newId(), input.listId!, contactId, timestamp],
            );
          }
          break;
        }
        case 'set_category':
          await client.query(
            `UPDATE contacts SET category = $1, updated_at = $2 WHERE id = ANY($3::text[])`,
            [cleanNullableText(input.category), timestamp, existingIds],
          );
          break;
        case 'set_client':
          await client.query(
            `UPDATE contacts SET client_name = $1, updated_at = $2 WHERE id = ANY($3::text[])`,
            [cleanNullableText(input.clientName), timestamp, existingIds],
          );
          break;
        case 'delete':
          await client.query(`DELETE FROM list_members WHERE contact_id = ANY($1::text[])`, [existingIds]);
          await client.query(`DELETE FROM contacts WHERE id = ANY($1::text[])`, [existingIds]);
          break;
      }
    });

    if (input.action === 'opt_out') {
      const timestamp = nowIso();
      await Promise.all(
        matchedContactIds.map((contactId) =>
          this.database.saveOptOutInDatabase({
            id: newId(),
            contactId,
            source: 'manual',
            createdAt: timestamp,
          }),
        ),
      );
    }

    if (input.action === 'delete') {
      await this.database.deleteOptOutsInDatabaseByContactIds(matchedContactIds);
    }

    await this.audit.log({
      actorUserId: actor.id,
      action: 'contacts.bulk_action',
      entityType: 'contact',
      entityId: matchedContactIds.join(','),
      metadata: {
        action: input.action,
        count: affected,
        listId: input.listId ?? null,
        category: input.category ?? null,
        clientName: input.clientName ?? null,
      },
    });

    return { affected };
  }

  async setOptOut(contactId: string, actor: UserSession, source: OptOutRecord['source'] = 'manual') {
    const timestamp = nowIso();
    await this.database.postgresTransaction(async (client) => {
      const contact = await getContactByIdFromDatabase(client, contactId);
      if (!contact) {
        throw new NotFoundException('Contato não encontrado');
      }

      await client.query(
        `UPDATE contacts
         SET is_opted_out = true, opted_out_at = $1, opt_out_source = $2, updated_at = $3
         WHERE id = $4`,
        [timestamp, source, timestamp, contactId],
      );
    });

    await this.database.saveOptOutInDatabase({
      id: newId(),
      contactId,
      source,
      createdAt: timestamp,
    });

    await this.audit.log({
      actorUserId: actor.id,
      action: 'contact.opt_out',
      entityType: 'contact',
      entityId: contactId,
    });
  }

  async clearOptOut(contactId: string, actor: UserSession) {
    await this.database.postgresTransaction(async (client) => {
      const contact = await getContactByIdFromDatabase(client, contactId);
      if (!contact) {
        throw new NotFoundException('Contato não encontrado');
      }

      await client.query(
        `UPDATE contacts
         SET is_opted_out = false, opted_out_at = NULL, opt_out_source = NULL, updated_at = $1
         WHERE id = $2`,
        [nowIso(), contactId],
      );
    });

    await this.audit.log({
      actorUserId: actor.id,
      action: 'contact.opt_in',
      entityType: 'contact',
      entityId: contactId,
    });
  }
}

const parseCsvMatrix = (content: Buffer): string[][] =>
  parse(content, {
    bom: true,
    delimiter: [',', ';'],
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  }) as string[][];

const toColumnRecords = (matrix: string[][]): { headers: string[]; records: Array<Record<string, string>> } => {
  const [headerRow, ...rows] = matrix;
  if (!headerRow?.length) {
    throw new BadRequestException('CSV sem cabeçalhos');
  }

  const headers = ensureUniqueHeaders(headerRow);
  const records = rows.map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = String(row[index] ?? '').trim();
    });
    return record;
  });

  return { headers, records };
};

const ensureUniqueHeaders = (headers: string[]): string[] => {
  const counts = new Map<string, number>();

  return headers.map((value, index) => {
    const base = cleanHeader(value) || `coluna_${index + 1}`;
    const nextCount = (counts.get(base) ?? 0) + 1;
    counts.set(base, nextCount);
    return nextCount === 1 ? base : `${base}_${nextCount}`;
  });
};

const cleanHeader = (value: string): string => value.trim();

const recommendMapping = (
  headers: string[],
): Record<CsvImportField, string | null> => {
  const normalizedHeaders = headers.map((header) => ({
    original: header,
    normalized: normalizeHeaderAlias(header),
  }));

  return IMPORTABLE_FIELDS.reduce<Record<CsvImportField, string | null>>((accumulator, field) => {
    const match = normalizedHeaders.find(({ normalized }) =>
      FIELD_ALIASES[field.key].some((alias) => normalized.includes(normalizeHeaderAlias(alias))),
    );
    accumulator[field.key] = match?.original ?? null;
    return accumulator;
  }, {} as Record<CsvImportField, string | null>);
};

const normalizeMapping = (
  mapping: Partial<Record<CsvImportField, string | null>> | undefined,
  headers: string[],
): Record<CsvImportField, string | null> => {
  const recommended = recommendMapping(headers);
  const merged = { ...recommended, ...(mapping ?? {}) };
  const available = new Set(headers);

  return Object.fromEntries(
    Object.entries(merged).map(([key, value]) => [
      key,
      value && available.has(value) ? value : null,
    ]),
  ) as Record<CsvImportField, string | null>;
};

const normalizeHeaderAlias = (value: string): string =>
  value
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toLowerCase();

const normalizeImportDefaults = (defaults?: CsvImportDefaults): Required<CsvImportDefaults> => ({
  clientName: cleanNullableText(defaults?.clientName),
  category: cleanNullableText(defaults?.category),
  status: normalizeRecordStatus(defaults?.status),
});

const normalizeRecordStatus = (value?: string | null): 'active' | 'inactive' => {
  const normalized = String(value ?? '')
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  if (['inativo', 'inactive', 'desativado', 'desligado'].includes(normalized)) {
    return 'inactive';
  }

  return 'active';
};

const pickMappedValue = (row: Record<string, string>, header?: string | null): string =>
  header ? String(row[header] ?? '').trim() : '';

const splitName = (value?: string | null): { firstName: string; lastName: string | null } => {
  const normalized = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!normalized) {
    return { firstName: '', lastName: null };
  }

  const [firstName, ...rest] = normalized.split(' ');
  return {
    firstName,
    lastName: rest.length ? rest.join(' ') : null,
  };
};

const joinName = (firstName?: string | null, lastName?: string | null): string =>
  [String(firstName ?? '').trim(), String(lastName ?? '').trim()].filter(Boolean).join(' ').trim();

const resolveContactNames = (
  input: ContactInput,
  existing?: ContactRecord,
): { firstName: string; lastName: string | null; fullName: string } => {
  const directFirstName = cleanNullableText(input.firstName);
  const directLastName = cleanNullableText(input.lastName);
  const fullNameInput = cleanNullableText(input.name);
  const splitFromFullName = splitName(fullNameInput);
  const splitExistingName = splitName(existing?.name);

  const firstName =
    directFirstName ||
    splitFromFullName.firstName ||
    existing?.firstName ||
    splitExistingName.firstName ||
    'Sem nome';

  const lastName =
    directLastName ??
    splitFromFullName.lastName ??
    existing?.lastName ??
    splitExistingName.lastName ??
    null;

  return {
    firstName,
    lastName,
    fullName: joinName(firstName, lastName) || 'Sem nome',
  };
};

const collectAttributes = (
  row: Record<string, string>,
  mapping: Record<CsvImportField, string | null>,
): Record<string, string> => {
  const mappedHeaders = new Set(Object.values(mapping).filter(Boolean));
  return Object.fromEntries(
    Object.entries(row)
      .filter(([key, value]) => !mappedHeaders.has(key) && value.trim() !== '')
      .map(([key, value]) => [key, value.trim()]),
  );
};

const createNewContact = (
  input: ContactInput,
  normalizedPhone: { phoneE164: string; error?: string },
  timestamp: string,
): ContactRecord => {
  const names = resolveContactNames(input);

  return {
    id: newId(),
    externalRef: cleanNullableText(input.externalRef),
    clientName: cleanNullableText(input.clientName),
    firstName: names.firstName,
    lastName: names.lastName,
    name: names.fullName,
    category: cleanNullableText(input.category),
    recordStatus: normalizeRecordStatus(input.recordStatus),
    phoneRaw: String(input.phone ?? '').trim(),
    phoneE164: normalizedPhone.phoneE164,
    phoneHash: hash(normalizedPhone.phoneE164.replace(/^\+/, '')),
    email: cleanNullableText(input.email),
    attributes: sanitizeAttributes(input.attributes),
    isValid: !normalizedPhone.error,
    validationError: normalizedPhone.error ?? null,
    isOptedOut: false,
    optedOutAt: null,
    optOutSource: null,
    importedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
};

const updateExistingContact = (
  existing: ContactRecord,
  input: ContactInput,
  normalizedPhone: { phoneE164: string; error?: string },
  timestamp: string,
): ContactRecord => {
  const names = resolveContactNames(input, existing);

  return {
    ...existing,
    externalRef: cleanNullableText(input.externalRef) ?? existing.externalRef ?? null,
    clientName: cleanNullableText(input.clientName) ?? existing.clientName ?? null,
    firstName: names.firstName,
    lastName: names.lastName,
    name: names.fullName,
    category: cleanNullableText(input.category) ?? existing.category ?? null,
    recordStatus: normalizeRecordStatus(input.recordStatus ?? existing.recordStatus),
    phoneRaw: String(input.phone ?? existing.phoneRaw).trim(),
    phoneE164: normalizedPhone.phoneE164 || existing.phoneE164,
    phoneHash: hash((normalizedPhone.phoneE164 || existing.phoneE164).replace(/^\+/, '')),
    email: cleanNullableText(input.email) ?? existing.email ?? null,
    attributes: sanitizeAttributes(input.attributes ?? existing.attributes),
    isValid: !normalizedPhone.error,
    validationError: normalizedPhone.error ?? null,
    importedAt: timestamp,
    updatedAt: timestamp,
  };
};

const sanitizeAttributes = (attributes?: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(attributes ?? {})
      .map(([key, value]) => [key.trim(), String(value).trim()])
      .filter(([key, value]) => key && value),
  );

const cleanText = (value: string | undefined, fallback: string): string => {
  const nextValue = String(value ?? '').trim();
  return nextValue || fallback;
};

const cleanNullableText = (value: string | null | undefined): string | null => {
  const nextValue = String(value ?? '').trim();
  return nextValue ? nextValue : null;
};

const mapContactRow = (row: Record<string, unknown>): ContactRecord => ({
  id: String(row.id),
  externalRef: cleanNullableText(toOptionalString(row.external_ref)),
  clientName: cleanNullableText(toOptionalString(row.client_name)),
  firstName: String(row.first_name ?? 'Sem nome'),
  lastName: cleanNullableText(toOptionalString(row.last_name)),
  name: String(row.name ?? 'Sem nome'),
  category: cleanNullableText(toOptionalString(row.category)),
  recordStatus: String(row.record_status) === 'inactive' ? 'inactive' : 'active',
  phoneRaw: String(row.phone_raw ?? ''),
  phoneE164: String(row.phone_e164 ?? ''),
  phoneHash: String(row.phone_hash ?? ''),
  email: cleanNullableText(toOptionalString(row.email)),
  attributes: parseAttributes(row.attributes_json),
  isValid: Number(row.is_valid ?? 0) === 1,
  validationError: cleanNullableText(toOptionalString(row.validation_error)),
  isOptedOut: Number(row.is_opted_out ?? 0) === 1,
  optedOutAt: cleanNullableText(toOptionalString(row.opted_out_at)),
  optOutSource: cleanNullableText(toOptionalString(row.opt_out_source)),
  importedAt: cleanNullableText(toOptionalString(row.imported_at)),
  createdAt: String(row.created_at ?? nowIso()),
  updatedAt: String(row.updated_at ?? nowIso()),
});

const mapListRow = (row: Record<string, unknown>): ListRecord => ({
  id: String(row.id),
  name: String(row.name),
  description: cleanNullableText(toOptionalString(row.description)),
  sourceType: String(row.source_type) as ListRecord['sourceType'],
  sourceFilePath: cleanNullableText(toOptionalString(row.source_file_path)),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

const getContactByIdFromDatabase = (
  database: Pick<PoolClient, 'query'>,
  contactId: string,
): Promise<ContactRecord | null> =>
  database
    .query(
      `SELECT
        id, external_ref, client_name, first_name, last_name, name, category, record_status,
        phone_raw, phone_e164, phone_hash, email, attributes_json, is_valid, validation_error,
        is_opted_out, opted_out_at, opt_out_source, imported_at, created_at, updated_at
       FROM contacts
       WHERE id = $1`,
      [contactId],
    )
    .then((result) => {
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row ? mapContactRow(row) : null;
    });

const ensurePhoneIsUniqueInDatabase = (
  database: Pick<PoolClient, 'query'>,
  phoneHash: string,
  excludeContactId?: string,
) =>
  database
    .query(
      excludeContactId
        ? 'SELECT id FROM contacts WHERE phone_hash = $1 AND id != $2 LIMIT 1'
        : 'SELECT id FROM contacts WHERE phone_hash = $1 LIMIT 1',
      excludeContactId ? [phoneHash, excludeContactId] : [phoneHash],
    )
    .then((result) => {
      const row = result.rows[0];

      if (row) {
        throw new BadRequestException('Já existe um contato com este telefone');
      }
    });

const ensureListIdsExistInDatabase = async (
  database: Pick<PoolClient, 'query'>,
  listIds: string[] | undefined,
) => {
  const ids = [...new Set((listIds ?? []).filter(Boolean))];
  if (ids.length === 0) {
    return;
  }

  const result = await database.query('SELECT COUNT(*)::int AS count FROM lists WHERE id = ANY($1::text[])', [
    ids,
  ]);
  const count = Number(result.rows[0]?.count ?? 0);

  if (count !== ids.length) {
    throw new NotFoundException('Uma ou mais listas não foram encontradas');
  }
};

const selectExistingContactIds = async (
  database: Pick<PoolClient, 'query'>,
  contactIds: string[],
): Promise<string[]> => {
  const ids = [...new Set(contactIds.filter(Boolean))];
  if (ids.length === 0) {
    return [];
  }

  const result = await database.query('SELECT id FROM contacts WHERE id = ANY($1::text[])', [ids]);
  const rows = result.rows as Array<Record<string, unknown>>;
  return rows.map((row) => String(row.id));
};

const insertContactPg = async (
  database: Pick<PoolClient, 'query'>,
  contact: ContactRecord,
) => {
  await database.query(
    `INSERT INTO contacts (
      id, external_ref, client_name, first_name, last_name, name, category, record_status,
      phone_raw, phone_e164, phone_hash, email, attributes_json, is_valid, validation_error,
      is_opted_out, opted_out_at, opt_out_source, imported_at, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
    [
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
      contact.isValid,
      contact.validationError ?? null,
      contact.isOptedOut,
      contact.optedOutAt ?? null,
      contact.optOutSource ?? null,
      contact.importedAt ?? null,
      contact.createdAt,
      contact.updatedAt,
    ],
  );
};

const updateContactPg = async (
  database: Pick<PoolClient, 'query'>,
  contact: ContactRecord,
) => {
  await database.query(
    `UPDATE contacts
     SET external_ref = $1, client_name = $2, first_name = $3, last_name = $4, name = $5, category = $6,
         record_status = $7, phone_raw = $8, phone_e164 = $9, phone_hash = $10, email = $11,
         attributes_json = $12, is_valid = $13, validation_error = $14, is_opted_out = $15,
         opted_out_at = $16, opt_out_source = $17, imported_at = $18, updated_at = $19
     WHERE id = $20`,
    [
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
      contact.isValid,
      contact.validationError ?? null,
      contact.isOptedOut,
      contact.optedOutAt ?? null,
      contact.optOutSource ?? null,
      contact.importedAt ?? null,
      contact.updatedAt,
      contact.id,
    ],
  );
};

const toStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.map((item) => String(item)).filter(Boolean))].sort()
    : [];

const parseListCategoryStats = (value: unknown): ListCategorySummary[] => {
  const parsed =
    typeof value === 'string'
      ? safeParseJsonArray(value)
      : Array.isArray(value)
        ? value
        : [];

  return parsed
    .flatMap((item) => {
      if (!item || typeof item !== 'object') {
        return [];
      }

      const record = item as Record<string, unknown>;
      const categoryValue = cleanNullableText(toOptionalString(record.value));
      if (!categoryValue) {
        return [];
      }

      return [
        {
          value: categoryValue,
          label: categoryValue,
          eligibleMembers: Number(record.eligibleMembers ?? 0),
          totalMembers: Number(record.totalMembers ?? 0),
        } satisfies ListCategorySummary,
      ];
    })
    .sort((left, right) =>
      left.label.localeCompare(right.label, 'pt-BR', {
        sensitivity: 'base',
        numeric: true,
      }),
    );
};

const parseAttributes = (value: unknown): Record<string, string> => {
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed ?? {}).map(([key, rawValue]) => [key, String(rawValue ?? '')]),
    );
  } catch {
    return {};
  }
};

const toOptionalString = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null;
  }
  return String(value);
};

const safeParseJsonArray = (value: string): unknown[] => {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const updateImportJob = (job: CsvImportJob, patch: Partial<CsvImportJob>) => {
  Object.assign(job, patch);
};

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });
