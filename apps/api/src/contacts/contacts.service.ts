import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { DatabaseSync } from 'node:sqlite';
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
    const state = await this.database.read();
    return this.buildContactList(state);
  }

  async listContactsPage(params: ContactsListParams): Promise<PaginatedContactsResult> {
    const limit = Math.max(1, Math.min(250, Number(params.limit ?? 50)));
    const offset = Math.max(0, Number(params.offset ?? 0));
    return this.database.execute((database) => {
      const total = Number(
        (
          database.prepare('SELECT COUNT(*) as count FROM contacts').get() as {
            count: number;
          }
        ).count ?? 0,
      );
      const rows = database
        .prepare(
          `SELECT
            id, external_ref, client_name, first_name, last_name, name, category, record_status,
            phone_raw, phone_e164, phone_hash, email, attributes_json, is_valid, validation_error,
            is_opted_out, opted_out_at, opt_out_source, imported_at, created_at, updated_at
           FROM contacts
           ORDER BY updated_at DESC
           LIMIT ? OFFSET ?`,
        )
        .all(limit, offset) as Array<Record<string, unknown>>;
      const contacts = rows.map(mapContactRow);
      const listNamesByContactId = new Map<string, string[]>();

      if (contacts.length > 0) {
        const { placeholders, values } = buildInClause(contacts.map((contact) => contact.id));
        const membershipRows = database
          .prepare(
            `SELECT lm.contact_id, l.name
             FROM list_members lm
             JOIN lists l ON l.id = lm.list_id
             WHERE lm.contact_id IN (${placeholders})
             ORDER BY l.name ASC`,
          )
          .all(...values) as Array<Record<string, unknown>>;

        for (const row of membershipRows) {
          const contactId = String(row.contact_id);
          const listName = String(row.name);
          const current = listNamesByContactId.get(contactId) ?? [];
          current.push(listName);
          listNamesByContactId.set(contactId, current);
        }
      }

      return {
        items: contacts.map((contact) => ({
          ...contact,
          listNames: [...new Set(listNamesByContactId.get(contact.id) ?? [])].sort(),
        })),
        total,
        limit,
        offset,
      };
    });
  }

  async listLists() {
    return this.database.execute((database) => {
      const rows = database
        .prepare(
          `SELECT
            l.id,
            l.name,
            l.description,
            l.source_type,
            l.source_file_path,
            l.created_at,
            l.updated_at,
            COUNT(DISTINCT lm.contact_id) as total_members,
            COUNT(
              DISTINCT CASE
                WHEN c.is_valid = 1 AND c.is_opted_out = 0 AND c.record_status = 'active'
                THEN lm.contact_id
              END
            ) as eligible_members
           FROM lists l
           LEFT JOIN list_members lm ON lm.list_id = l.id
           LEFT JOIN contacts c ON c.id = lm.contact_id
           GROUP BY l.id
           ORDER BY l.created_at DESC`,
        )
        .all() as Array<Record<string, unknown>>;

      return rows.map((row) => ({
        ...mapListRow(row),
        totalMembers: Number(row.total_members ?? 0),
        eligibleMembers: Number(row.eligible_members ?? 0),
      }));
    });
  }

  async getList(id: string) {
    return this.database.execute((database) => {
      const row = database
        .prepare(
          `SELECT id, name, description, source_type, source_file_path, created_at, updated_at
           FROM lists
           WHERE id = ?`,
        )
        .get(id) as Record<string, unknown> | undefined;
      if (!row) {
        throw new NotFoundException('Lista não encontrada');
      }

      const members = database
        .prepare(
          `SELECT
            c.id, c.external_ref, c.client_name, c.first_name, c.last_name, c.name, c.category, c.record_status,
            c.phone_raw, c.phone_e164, c.phone_hash, c.email, c.attributes_json, c.is_valid, c.validation_error,
            c.is_opted_out, c.opted_out_at, c.opt_out_source, c.imported_at, c.created_at, c.updated_at
           FROM list_members lm
           JOIN contacts c ON c.id = lm.contact_id
           WHERE lm.list_id = ?
           ORDER BY c.updated_at DESC`,
        )
        .all(id) as Array<Record<string, unknown>>;

      return {
        ...mapListRow(row),
        members: members.map(mapContactRow),
      };
    });
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

    await this.database.transaction((database) => {
      database
        .prepare(
          `INSERT INTO lists (
            id, name, description, source_type, source_file_path, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          list.id,
          list.name,
          list.description ?? null,
          list.sourceType,
          list.sourceFilePath ?? null,
          list.createdAt,
          list.updatedAt,
        );
    });

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
      await this.database.transaction((database) => {
        database
          .prepare(
            `INSERT INTO lists (
              id, name, description, source_type, source_file_path, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            list.id,
            list.name,
            list.description ?? null,
            list.sourceType,
            list.sourceFilePath ?? null,
            list.createdAt,
            list.updatedAt,
          );
      });

      const existingContacts = await this.database.execute((database) => {
        const rows = database
          .prepare(
            `SELECT
              id, external_ref, client_name, first_name, last_name, name, category, record_status,
              phone_raw, phone_e164, phone_hash, email, attributes_json, is_valid, validation_error,
              is_opted_out, opted_out_at, opt_out_source, imported_at, created_at, updated_at
             FROM contacts`,
          )
          .all() as Array<Record<string, unknown>>;
        return rows.map(mapContactRow);
      });

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

        await this.database.transaction((database) => {
          const insertContactStatement = database.prepare(
            `INSERT INTO contacts (
              id, external_ref, client_name, first_name, last_name, name, category, record_status,
              phone_raw, phone_e164, phone_hash, email, attributes_json, is_valid, validation_error,
              is_opted_out, opted_out_at, opt_out_source, imported_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          const updateContactStatement = database.prepare(
            `UPDATE contacts
             SET external_ref = ?, client_name = ?, first_name = ?, last_name = ?, name = ?, category = ?,
                 record_status = ?, phone_raw = ?, phone_e164 = ?, phone_hash = ?, email = ?,
                 attributes_json = ?, is_valid = ?, validation_error = ?, is_opted_out = ?,
                 opted_out_at = ?, opt_out_source = ?, imported_at = ?, updated_at = ?
             WHERE id = ?`,
          );
          const insertMembershipStatement = database.prepare(
            `INSERT OR IGNORE INTO list_members (
              id, list_id, contact_id, created_at
            ) VALUES (?, ?, ?, ?)`,
          );

          for (const contact of contactsToInsert) {
            insertContactRow(insertContactStatement, contact);
          }

          for (const contact of contactsToUpdate) {
            updateContactRow(updateContactStatement, contact);
          }

          for (const membership of membershipsToInsert) {
            insertMembershipStatement.run(
              membership.id,
              membership.listId,
              membership.contactId,
              membership.createdAt,
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

      await this.database.transaction((database) => {
        database
          .prepare(
            `INSERT INTO imports (
              id, list_id, file_name, file_sha256, total_rows, valid_rows, invalid_rows, duplicate_rows,
              field_mapping_json, defaults_json, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
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
      });

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

      updateImportJob(job, {
        status: 'completed',
        processedRows: params.records.length,
        importRecord,
        list,
        updatedAt: nowIso(),
      });
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

    await this.database.transaction((database) => {
      ensurePhoneIsUniqueInDatabase(database, contact.phoneHash);
      ensureListIdsExistInDatabase(database, input.listIds);
      insertContactRow(
        database.prepare(
          `INSERT INTO contacts (
            id, external_ref, client_name, first_name, last_name, name, category, record_status,
            phone_raw, phone_e164, phone_hash, email, attributes_json, is_valid, validation_error,
            is_opted_out, opted_out_at, opt_out_source, imported_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ),
        contact,
      );
      const membershipStatement = database.prepare(
        `INSERT OR IGNORE INTO list_members (
          id, list_id, contact_id, created_at
        ) VALUES (?, ?, ?, ?)`,
      );
      for (const listId of input.listIds ?? []) {
        membershipStatement.run(newId(), listId, contact.id, nowIso());
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

    await this.database.transaction((database) => {
      const existing = getContactByIdFromDatabase(database, id);
      if (!existing) {
        throw new NotFoundException('Contato não encontrado');
      }

      const normalized = normalizePhone(String(input.phone ?? existing.phoneRaw));
      const nextPhoneHash = hash((normalized.phoneE164 || existing.phoneE164).replace(/^\+/, ''));
      ensurePhoneIsUniqueInDatabase(database, nextPhoneHash, id);

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

      updateContactRow(
        database.prepare(
          `UPDATE contacts
           SET external_ref = ?, client_name = ?, first_name = ?, last_name = ?, name = ?, category = ?,
               record_status = ?, phone_raw = ?, phone_e164 = ?, phone_hash = ?, email = ?,
               attributes_json = ?, is_valid = ?, validation_error = ?, is_opted_out = ?,
               opted_out_at = ?, opt_out_source = ?, imported_at = ?, updated_at = ?
           WHERE id = ?`,
        ),
        updatedContact,
      );

      if (input.listIds) {
        ensureListIdsExistInDatabase(database, input.listIds);
        database.prepare('DELETE FROM list_members WHERE contact_id = ?').run(id);
        const membershipStatement = database.prepare(
          `INSERT OR IGNORE INTO list_members (
            id, list_id, contact_id, created_at
          ) VALUES (?, ?, ?, ?)`,
        );
        for (const listId of input.listIds) {
          membershipStatement.run(newId(), listId, id, nowIso());
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
    await this.database.transaction((database) => {
      const existing = getContactByIdFromDatabase(database, id);
      if (!existing) {
        throw new NotFoundException('Contato não encontrado');
      }
      database.prepare('DELETE FROM list_members WHERE contact_id = ?').run(id);
      database.prepare('DELETE FROM contacts WHERE id = ?').run(id);
    });

    await this.database.write((state) => {
      state.optOuts = state.optOuts.filter((item) => item.contactId !== id);
    });

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

    await this.database.transaction((database) => {
      const existingIds = selectExistingContactIds(database, contactIds);
      if (existingIds.length === 0) {
        throw new NotFoundException('Nenhum contato encontrado');
      }

      matchedContactIds = existingIds;
      affected = existingIds.length;
      const { placeholders, values } = buildInClause(existingIds);
      const timestamp = nowIso();

      if (input.action === 'assign_list') {
        if (!input.listId) {
          throw new BadRequestException('Informe a lista para vincular');
        }
        ensureListIdsExistInDatabase(database, [input.listId]);
      }

      switch (input.action) {
        case 'activate':
          database
            .prepare(`UPDATE contacts SET record_status = 'active', updated_at = ? WHERE id IN (${placeholders})`)
            .run(timestamp, ...values);
          break;
        case 'deactivate':
          database
            .prepare(`UPDATE contacts SET record_status = 'inactive', updated_at = ? WHERE id IN (${placeholders})`)
            .run(timestamp, ...values);
          break;
        case 'opt_out':
          database
            .prepare(
              `UPDATE contacts
               SET is_opted_out = 1, opted_out_at = ?, opt_out_source = 'manual', updated_at = ?
               WHERE id IN (${placeholders})`,
            )
            .run(timestamp, timestamp, ...values);
          break;
        case 'opt_in':
          database
            .prepare(
              `UPDATE contacts
               SET is_opted_out = 0, opted_out_at = NULL, opt_out_source = NULL, updated_at = ?
               WHERE id IN (${placeholders})`,
            )
            .run(timestamp, ...values);
          break;
        case 'assign_list': {
          const insertMembershipStatement = database.prepare(
            `INSERT OR IGNORE INTO list_members (
              id, list_id, contact_id, created_at
            ) VALUES (?, ?, ?, ?)`,
          );
          for (const contactId of existingIds) {
            insertMembershipStatement.run(newId(), input.listId!, contactId, timestamp);
          }
          break;
        }
        case 'set_category':
          database
            .prepare(`UPDATE contacts SET category = ?, updated_at = ? WHERE id IN (${placeholders})`)
            .run(cleanNullableText(input.category), timestamp, ...values);
          break;
        case 'set_client':
          database
            .prepare(`UPDATE contacts SET client_name = ?, updated_at = ? WHERE id IN (${placeholders})`)
            .run(cleanNullableText(input.clientName), timestamp, ...values);
          break;
        case 'delete':
          database.prepare(`DELETE FROM list_members WHERE contact_id IN (${placeholders})`).run(...values);
          database.prepare(`DELETE FROM contacts WHERE id IN (${placeholders})`).run(...values);
          break;
      }
    });

    if (input.action === 'opt_out') {
      const timestamp = nowIso();
      await this.database.write((state) => {
        for (const contactId of matchedContactIds) {
          state.optOuts.push({
            id: newId(),
            contactId,
            source: 'manual',
            createdAt: timestamp,
          });
        }
      });
    }

    if (input.action === 'delete') {
      await this.database.write((state) => {
        state.optOuts = state.optOuts.filter((item) => !matchedContactIds.includes(item.contactId));
      });
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
    await this.database.transaction((database) => {
      const contact = getContactByIdFromDatabase(database, contactId);
      if (!contact) {
        throw new NotFoundException('Contato não encontrado');
      }

      database
        .prepare(
          `UPDATE contacts
           SET is_opted_out = 1, opted_out_at = ?, opt_out_source = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(timestamp, source, timestamp, contactId);
    });

    await this.database.write((state) => {
      state.optOuts.push({
        id: newId(),
        contactId,
        source,
        createdAt: timestamp,
      });
    });

    await this.audit.log({
      actorUserId: actor.id,
      action: 'contact.opt_out',
      entityType: 'contact',
      entityId: contactId,
    });
  }

  async clearOptOut(contactId: string, actor: UserSession) {
    await this.database.transaction((database) => {
      const contact = getContactByIdFromDatabase(database, contactId);
      if (!contact) {
        throw new NotFoundException('Contato não encontrado');
      }

      database
        .prepare(
          `UPDATE contacts
           SET is_opted_out = 0, opted_out_at = NULL, opt_out_source = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(nowIso(), contactId);
    });

    await this.audit.log({
      actorUserId: actor.id,
      action: 'contact.opt_in',
      entityType: 'contact',
      entityId: contactId,
    });
  }

  private buildContactList(state: Awaited<ReturnType<DatabaseService['read']>>) {
    const listNamesByContactId = new Map<string, string[]>();
    const listNameById = new Map(state.lists.map((list) => [list.id, list.name]));

    for (const member of state.listMembers) {
      const listName = listNameById.get(member.listId);
      if (!listName) {
        continue;
      }

      const current = listNamesByContactId.get(member.contactId) ?? [];
      current.push(listName);
      listNamesByContactId.set(member.contactId, current);
    }

    return state.contacts
      .map((contact) => ({
        ...contact,
        listNames: [...new Set(listNamesByContactId.get(contact.id) ?? [])].sort(),
      }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
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
  database: DatabaseSync,
  contactId: string,
): ContactRecord | null => {
  const row = database
    .prepare(
      `SELECT
        id, external_ref, client_name, first_name, last_name, name, category, record_status,
        phone_raw, phone_e164, phone_hash, email, attributes_json, is_valid, validation_error,
        is_opted_out, opted_out_at, opt_out_source, imported_at, created_at, updated_at
       FROM contacts
       WHERE id = ?`,
    )
    .get(contactId) as Record<string, unknown> | undefined;

  return row ? mapContactRow(row) : null;
};

const ensurePhoneIsUniqueInDatabase = (
  database: DatabaseSync,
  phoneHash: string,
  excludeContactId?: string,
) => {
  const row = excludeContactId
    ? (database
        .prepare('SELECT id FROM contacts WHERE phone_hash = ? AND id != ? LIMIT 1')
        .get(phoneHash, excludeContactId) as Record<string, unknown> | undefined)
    : (database
        .prepare('SELECT id FROM contacts WHERE phone_hash = ? LIMIT 1')
        .get(phoneHash) as Record<string, unknown> | undefined);

  if (row) {
    throw new BadRequestException('Já existe um contato com este telefone');
  }
};

const ensureListIdsExistInDatabase = (database: DatabaseSync, listIds: string[] | undefined) => {
  const ids = [...new Set((listIds ?? []).filter(Boolean))];
  if (ids.length === 0) {
    return;
  }

  const { placeholders, values } = buildInClause(ids);
  const count = Number(
    (
      database
        .prepare(`SELECT COUNT(*) as count FROM lists WHERE id IN (${placeholders})`)
        .get(...values) as { count: number }
    ).count ?? 0,
  );

  if (count !== ids.length) {
    throw new NotFoundException('Uma ou mais listas não foram encontradas');
  }
};

const selectExistingContactIds = (database: DatabaseSync, contactIds: string[]): string[] => {
  const ids = [...new Set(contactIds.filter(Boolean))];
  if (ids.length === 0) {
    return [];
  }

  const { placeholders, values } = buildInClause(ids);
  const rows = database
    .prepare(`SELECT id FROM contacts WHERE id IN (${placeholders})`)
    .all(...values) as Array<Record<string, unknown>>;
  return rows.map((row) => String(row.id));
};

const insertContactRow = (
  statement: ReturnType<DatabaseSync['prepare']>,
  contact: ContactRecord,
) => {
  statement.run(
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
};

const updateContactRow = (
  statement: ReturnType<DatabaseSync['prepare']>,
  contact: ContactRecord,
) => {
  statement.run(
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
    contact.updatedAt,
    contact.id,
  );
};

const buildInClause = (values: string[]): { placeholders: string; values: string[] } => {
  if (values.length === 0) {
    return { placeholders: "''", values: [] };
  }

  return {
    placeholders: values.map(() => '?').join(', '),
    values,
  };
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

const updateImportJob = (job: CsvImportJob, patch: Partial<CsvImportJob>) => {
  Object.assign(job, patch);
};

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });
