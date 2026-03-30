import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
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

const IMPORTABLE_FIELDS: Array<{ key: CsvImportField; label: string; required: boolean }> = [
  { key: 'clientName', label: 'Cliente', required: false },
  { key: 'name', label: 'Contato', required: true },
  { key: 'phone', label: 'Telefone', required: true },
  { key: 'category', label: 'Categoria', required: false },
  { key: 'status', label: 'Status', required: false },
  { key: 'email', label: 'E-mail', required: false },
  { key: 'externalRef', label: 'Referência externa', required: false },
];

const FIELD_ALIASES: Record<CsvImportField, string[]> = {
  clientName: ['cliente', 'client', 'empresa', 'contratante'],
  name: ['contato', 'nome', 'name', 'responsavel', 'titular'],
  phone: ['telefone', 'celular', 'whatsapp', 'fone', 'phone', 'mobile'],
  category: ['categoria', 'category', 'segmento', 'tag'],
  status: ['status', 'situacao', 'situação', 'ativo', 'inativo'],
  email: ['email', 'e-mail', 'mail'],
  externalRef: ['id', 'codigo', 'código', 'external_ref', 'referencia', 'referência'],
};

@Injectable()
export class ContactsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async listContacts() {
    const state = await this.database.read();
    const listNamesByContactId = new Map<string, string[]>();

    for (const member of state.listMembers) {
      const list = state.lists.find((item) => item.id === member.listId);
      if (!list) {
        continue;
      }

      const current = listNamesByContactId.get(member.contactId) ?? [];
      current.push(list.name);
      listNamesByContactId.set(member.contactId, current);
    }

    return state.contacts
      .map((contact) => ({
        ...contact,
        listNames: [...new Set(listNamesByContactId.get(contact.id) ?? [])].sort(),
      }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async listLists() {
    const state = await this.database.read();
    return state.lists
      .map((list) => ({
        ...list,
        totalMembers: state.listMembers.filter((member) => member.listId === list.id).length,
        eligibleMembers: state.listMembers.filter((member) => {
          const contact = state.contacts.find((item) => item.id === member.contactId);
          return (
            contact?.isValid &&
            !contact.isOptedOut &&
            contact.recordStatus === 'active'
          );
        }).length,
      }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getList(id: string) {
    const state = await this.database.read();
    const list = state.lists.find((item) => item.id === id);
    if (!list) {
      throw new NotFoundException('Lista não encontrada');
    }

    const members = state.listMembers
      .filter((member) => member.listId === id)
      .map((member) => state.contacts.find((contact) => contact.id === member.contactId))
      .filter(Boolean);

    return {
      ...list,
      members,
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

    await this.database.write((state) => {
      state.lists.push(list);
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

  async importCsv(
    params: {
      listName: string;
      fileName: string;
      content: Buffer;
      mapping?: Partial<Record<CsvImportField, string | null>>;
      defaults?: CsvImportDefaults;
    },
    actor: UserSession,
  ): Promise<{ importRecord: ImportRecord; list: ListRecord }> {
    const matrix = parseCsvMatrix(params.content);
    const { headers, records } = toColumnRecords(matrix);
    if (records.length === 0) {
      throw new BadRequestException('CSV sem linhas para importar');
    }

    const mapping = normalizeMapping(params.mapping, headers);
    if (!mapping.name || !mapping.phone) {
      throw new BadRequestException('Mapeie pelo menos contato e telefone antes de importar');
    }

    const defaults = normalizeImportDefaults(params.defaults);
    const fileSha256 = createHash('sha256').update(params.content).digest('hex');
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

    await this.database.write((state) => {
      state.lists.push(list);

      for (const row of records) {
        const rawPhone = pickMappedValue(row, mapping.phone);
        const normalized = normalizePhone(rawPhone);
        const phoneHash = hash((normalized.phoneE164 || rawPhone).replace(/^\+/, ''));
        const existingContact = state.contacts.find((contact) => contact.phoneHash === phoneHash);
        const rowTimestamp = nowIso();
        const nextStatus = normalizeRecordStatus(
          pickMappedValue(row, mapping.status) || defaults.status,
        );
        const attributes = collectAttributes(row, mapping);

        const payload = {
          clientName:
            pickMappedValue(row, mapping.clientName) || defaults.clientName || existingContact?.clientName || null,
          name: pickMappedValue(row, mapping.name) || existingContact?.name || 'Sem nome',
          phone: rawPhone || existingContact?.phoneRaw || '',
          category:
            pickMappedValue(row, mapping.category) || defaults.category || existingContact?.category || null,
          email: pickMappedValue(row, mapping.email) || existingContact?.email || null,
          externalRef: pickMappedValue(row, mapping.externalRef) || existingContact?.externalRef || null,
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
          state.contacts = state.contacts.map((item) => (item.id === contact.id ? contact : item));
        } else {
          state.contacts.push(contact);
        }

        upsertListMembership(state.listMembers, list.id, contact.id);

        if (contact.isValid) {
          validRows += 1;
        } else {
          invalidRows += 1;
        }
      }

      state.imports.push({
        id: newId(),
        listId: list.id,
        fileName: params.fileName,
        fileSha256,
        totalRows: records.length,
        validRows,
        invalidRows,
        duplicateRows,
        fieldMapping: Object.fromEntries(
          Object.entries(mapping).map(([key, value]) => [key, value ?? null]),
        ),
        defaults: {
          clientName: defaults.clientName,
          category: defaults.category,
          status: defaults.status,
        },
        status: 'completed',
        createdAt: nowIso(),
      });
    });

    const importRecord = (await this.database.read()).imports.at(-1) as ImportRecord;
    await this.audit.log({
      actorUserId: actor.id,
      action: 'contacts.imported_csv',
      entityType: 'list',
      entityId: list.id,
      metadata: {
        fileName: params.fileName,
        totalRows: records.length,
        validRows,
        invalidRows,
        duplicateRows,
        mapping,
        defaults,
      },
    });

    return { importRecord, list };
  }

  async createContact(input: ContactInput, actor: UserSession) {
    const timestamp = nowIso();
    const normalized = normalizePhone(String(input.phone ?? ''));
    const contact = createNewContact(input, normalized, timestamp);

    await this.database.write((state) => {
      ensurePhoneIsUnique(state.contacts, contact.phoneHash);
      state.contacts.push(contact);
      ensureListIdsExist(state.lists, input.listIds);
      for (const listId of input.listIds ?? []) {
        upsertListMembership(state.listMembers, listId, contact.id);
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

    await this.database.write((state) => {
      const existing = state.contacts.find((item) => item.id === id);
      if (!existing) {
        throw new NotFoundException('Contato não encontrado');
      }

      const normalized = normalizePhone(String(input.phone ?? existing.phoneRaw));
      const nextPhoneHash = hash((normalized.phoneE164 || existing.phoneE164).replace(/^\+/, ''));
      ensurePhoneIsUnique(
        state.contacts.filter((item) => item.id !== id),
        nextPhoneHash,
      );

      updatedContact = updateExistingContact(
        existing,
        {
          clientName: input.clientName ?? existing.clientName,
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

      state.contacts = state.contacts.map((item) => (item.id === id ? updatedContact! : item));

      if (input.listIds) {
        ensureListIdsExist(state.lists, input.listIds);
        state.listMembers = state.listMembers.filter((member) => member.contactId !== id);
        for (const listId of input.listIds) {
          upsertListMembership(state.listMembers, listId, id);
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
    await this.database.write((state) => {
      const existing = state.contacts.find((item) => item.id === id);
      if (!existing) {
        throw new NotFoundException('Contato não encontrado');
      }

      state.contacts = state.contacts.filter((item) => item.id !== id);
      state.listMembers = state.listMembers.filter((member) => member.contactId !== id);
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

    await this.database.write((state) => {
      const contacts = state.contacts.filter((item) => contactIds.includes(item.id));
      if (!contacts.length) {
        throw new NotFoundException('Nenhum contato encontrado');
      }

      if (input.action === 'assign_list') {
        if (!input.listId) {
          throw new BadRequestException('Informe a lista para vincular');
        }
        ensureListIdsExist(state.lists, [input.listId]);
      }

      for (const contact of contacts) {
        switch (input.action) {
          case 'activate':
            contact.recordStatus = 'active';
            contact.updatedAt = nowIso();
            affected += 1;
            break;
          case 'deactivate':
            contact.recordStatus = 'inactive';
            contact.updatedAt = nowIso();
            affected += 1;
            break;
          case 'opt_out':
            contact.isOptedOut = true;
            contact.optedOutAt = nowIso();
            contact.optOutSource = 'manual';
            contact.updatedAt = nowIso();
            state.optOuts.push({
              id: newId(),
              contactId: contact.id,
              source: 'manual',
              createdAt: nowIso(),
            });
            affected += 1;
            break;
          case 'opt_in':
            contact.isOptedOut = false;
            contact.optedOutAt = null;
            contact.optOutSource = null;
            contact.updatedAt = nowIso();
            affected += 1;
            break;
          case 'assign_list':
            upsertListMembership(state.listMembers, input.listId!, contact.id);
            affected += 1;
            break;
          case 'set_category':
            contact.category = cleanNullableText(input.category);
            contact.updatedAt = nowIso();
            affected += 1;
            break;
          case 'set_client':
            contact.clientName = cleanNullableText(input.clientName);
            contact.updatedAt = nowIso();
            affected += 1;
            break;
          case 'delete':
            break;
        }
      }

      if (input.action === 'delete') {
        state.contacts = state.contacts.filter((item) => !contactIds.includes(item.id));
        state.listMembers = state.listMembers.filter((member) => !contactIds.includes(member.contactId));
        state.optOuts = state.optOuts.filter((item) => !contactIds.includes(item.contactId));
        affected = contacts.length;
      }
    });

    await this.audit.log({
      actorUserId: actor.id,
      action: 'contacts.bulk_action',
      entityType: 'contact',
      entityId: contactIds.join(','),
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
    await this.database.write((state) => {
      const contact = state.contacts.find((item) => item.id === contactId);
      if (!contact) {
        throw new NotFoundException('Contato não encontrado');
      }

      contact.isOptedOut = true;
      contact.optedOutAt = nowIso();
      contact.optOutSource = source;
      contact.updatedAt = nowIso();

      state.optOuts.push({
        id: newId(),
        contactId,
        source,
        createdAt: nowIso(),
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
    await this.database.write((state) => {
      const contact = state.contacts.find((item) => item.id === contactId);
      if (!contact) {
        throw new NotFoundException('Contato não encontrado');
      }

      contact.isOptedOut = false;
      contact.optedOutAt = null;
      contact.optOutSource = null;
      contact.updatedAt = nowIso();
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
): ContactRecord => ({
  id: newId(),
  externalRef: cleanNullableText(input.externalRef),
  clientName: cleanNullableText(input.clientName),
  name: cleanText(input.name, 'Sem nome'),
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
});

const updateExistingContact = (
  existing: ContactRecord,
  input: ContactInput,
  normalizedPhone: { phoneE164: string; error?: string },
  timestamp: string,
): ContactRecord => ({
  ...existing,
  externalRef: cleanNullableText(input.externalRef) ?? existing.externalRef ?? null,
  clientName: cleanNullableText(input.clientName) ?? existing.clientName ?? null,
  name: cleanText(input.name, existing.name || 'Sem nome'),
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
});

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

const ensurePhoneIsUnique = (contacts: ContactRecord[], phoneHash: string) => {
  if (contacts.some((item) => item.phoneHash === phoneHash)) {
    throw new BadRequestException('Já existe um contato com este telefone');
  }
};

const ensureListIdsExist = (lists: ListRecord[], listIds: string[] | undefined) => {
  for (const listId of listIds ?? []) {
    if (!lists.some((item) => item.id === listId)) {
      throw new NotFoundException(`Lista não encontrada: ${listId}`);
    }
  }
};

const upsertListMembership = (
  listMembers: ListMemberRecord[],
  listId: string,
  contactId: string,
) => {
  const membershipExists = listMembers.some(
    (member) => member.listId === listId && member.contactId === contactId,
  );

  if (!membershipExists) {
    listMembers.push({
      id: newId(),
      listId,
      contactId,
      createdAt: nowIso(),
    });
  }
};
