import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { PoolClient } from 'pg';
import { AuditService } from '../common/audit.service';
import { resolveClientScope, writeClientId } from '../common/scope';
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
  | 'id'
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
  | 'remove_list'
  | 'set_category'
  | 'set_client';

interface ContactInput {
  clientId?: string | null;
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

interface CsvUpdateSummary {
  updated: number;
  created: number;
  unchanged: number;
  conflicts: number;
  invalid: number;
}

interface CsvImportJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  // 'insert' = fluxo clássico (cria lista + upsert por telefone); 'update' =
  // atualização em massa casando por ID do cadastro (não cria lista).
  mode: 'insert' | 'update';
  fileName: string;
  listName: string;
  totalRows: number;
  processedRows: number;
  createdAt: string;
  updatedAt: string;
  importRecord?: ImportRecord;
  updateSummary?: CsvUpdateSummary;
  list?: ListRecord;
  error?: string | null;
}

/** Colunas lidas de `contacts` para reidratar um `ContactRecord` via `mapContactRow`. */
const CONTACT_COLUMNS = `
  id, client_id, external_ref, client_name, first_name, last_name, name, category, record_status,
  phone_raw, phone_e164, phone_hash, email, attributes_json, is_valid, validation_error,
  is_opted_out, opted_out_at, opt_out_source, imported_at, created_at, updated_at`;

const IMPORTABLE_FIELDS: Array<{ key: CsvImportField; label: string; required: boolean }> = [
  { key: 'id', label: 'ID do cadastro', required: false },
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
  id: ['id', 'id_cadastro', 'cadastro_id', 'contato_id', 'contact_id'],
  clientName: ['cliente', 'client', 'empresa', 'contratante'],
  firstName: ['nome', 'primeiro_nome', 'primeiro nome', 'first_name', 'first name'],
  lastName: ['sobrenome', 'ultimo_nome', 'último nome', 'last_name', 'last name'],
  name: ['contato', 'nome_completo', 'nome completo', 'name', 'responsavel', 'titular'],
  phone: ['telefone', 'celular', 'whatsapp', 'fone', 'phone', 'mobile'],
  category: ['categoria', 'category', 'segmento', 'tag'],
  status: ['status', 'situacao', 'situação', 'ativo', 'inativo'],
  email: ['email', 'e-mail', 'mail'],
  externalRef: ['codigo', 'código', 'external_ref', 'referencia', 'referência'],
};

@Injectable()
export class ContactsService {
  private readonly importJobs = new Map<string, CsvImportJob>();

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async listContacts(scope: string | null = null) {
    const args: unknown[] = [];
    let where = '';
    if (scope !== null) {
      args.push(scope);
      where = 'WHERE c.client_id = $1';
    }
    const rows = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT
        c.id, c.external_ref, c.client_name, c.first_name, c.last_name, c.name, c.category, c.record_status,
        c.phone_raw, c.phone_e164, c.phone_hash, c.email, c.attributes_json, c.is_valid, c.validation_error,
        c.is_opted_out, c.opted_out_at, c.opt_out_source, c.imported_at, c.created_at, c.updated_at,
        COALESCE(ARRAY_AGG(DISTINCT l.name ORDER BY l.name) FILTER (WHERE l.name IS NOT NULL), ARRAY[]::text[]) AS list_names,
        COALESCE(ARRAY_AGG(DISTINCT l.id) FILTER (WHERE l.id IS NOT NULL), ARRAY[]::text[]) AS list_ids
       FROM contacts c
       LEFT JOIN list_members lm ON lm.contact_id = c.id
       LEFT JOIN lists l ON l.id = lm.list_id
       ${where}
       GROUP BY c.id
       ORDER BY c.updated_at DESC`,
      args,
    );

    const deliveryFlags = await this.fetchDeliveryFlags(rows.map((row) => String(row.id)));
    return rows.map((row) => {
      const id = String(row.id);
      const flags = deliveryFlags.get(id);
      return {
        ...mapContactRow(row),
        listNames: toStringArray(row.list_names),
        listIds: toStringArray(row.list_ids),
        hasFailedMessage: flags?.hasFailedMessage ?? false,
        hasDeliveredUnread: flags?.hasDeliveredUnread ?? false,
      };
    });
  }

  /**
   * Agrega o histórico de entrega das mensagens por contato numa única query
   * (evita o JOIN de campaign_messages na consulta principal, que multiplicaria
   * as linhas junto ao join de list_members). O escopo por tenant já está
   * garantido: os contactIds recebidos já vêm filtrados pelo escopo do chamador.
   */
  private async fetchDeliveryFlags(
    contactIds: string[],
  ): Promise<Map<string, { hasFailedMessage: boolean; hasDeliveredUnread: boolean }>> {
    const flags = new Map<string, { hasFailedMessage: boolean; hasDeliveredUnread: boolean }>();
    if (contactIds.length === 0) {
      return flags;
    }
    const rows = await this.database.postgresQuery<{
      contact_id: string;
      has_failed: boolean;
      has_delivered_unread: boolean;
    }>(
      `SELECT contact_id,
        bool_or(status = 'failed')    AS has_failed,
        bool_or(status = 'delivered') AS has_delivered_unread
       FROM campaign_messages
       WHERE contact_id = ANY($1::text[])
       GROUP BY contact_id`,
      [contactIds],
    );
    for (const row of rows) {
      flags.set(String(row.contact_id), {
        hasFailedMessage: Boolean(row.has_failed),
        hasDeliveredUnread: Boolean(row.has_delivered_unread),
      });
    }
    return flags;
  }

  async listContactsPage(
    params: ContactsListParams,
    scope: string | null = null,
  ): Promise<PaginatedContactsResult> {
    const limit = Math.max(1, Math.min(250, Number(params.limit ?? 50)));
    const offset = Math.max(0, Number(params.offset ?? 0));
    const countArgs: unknown[] = [];
    let countWhere = '';
    if (scope !== null) {
      countArgs.push(scope);
      countWhere = 'WHERE client_id = $1';
    }
    const [{ count }] = await this.database.postgresQuery<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM contacts ${countWhere}`,
      countArgs,
    );
    const rowArgs: unknown[] = [];
    let rowWhere = '';
    if (scope !== null) {
      rowArgs.push(scope);
      rowWhere = 'WHERE c.client_id = $1';
    }
    rowArgs.push(limit);
    const limitPos = rowArgs.length;
    rowArgs.push(offset);
    const offsetPos = rowArgs.length;
    const rows = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT
        c.id, c.external_ref, c.client_name, c.first_name, c.last_name, c.name, c.category, c.record_status,
        c.phone_raw, c.phone_e164, c.phone_hash, c.email, c.attributes_json, c.is_valid, c.validation_error,
        c.is_opted_out, c.opted_out_at, c.opt_out_source, c.imported_at, c.created_at, c.updated_at,
        COALESCE(ARRAY_AGG(DISTINCT l.name ORDER BY l.name) FILTER (WHERE l.name IS NOT NULL), ARRAY[]::text[]) AS list_names,
        COALESCE(ARRAY_AGG(DISTINCT l.id) FILTER (WHERE l.id IS NOT NULL), ARRAY[]::text[]) AS list_ids
       FROM contacts c
       LEFT JOIN list_members lm ON lm.contact_id = c.id
       LEFT JOIN lists l ON l.id = lm.list_id
       ${rowWhere}
       GROUP BY c.id
       ORDER BY c.updated_at DESC
       LIMIT $${limitPos} OFFSET $${offsetPos}`,
      rowArgs,
    );

    const deliveryFlags = await this.fetchDeliveryFlags(rows.map((row) => String(row.id)));
    return {
      items: rows.map((row) => {
        const id = String(row.id);
        const flags = deliveryFlags.get(id);
        return {
          ...mapContactRow(row),
          listNames: toStringArray(row.list_names),
          listIds: toStringArray(row.list_ids),
          hasFailedMessage: flags?.hasFailedMessage ?? false,
          hasDeliveredUnread: flags?.hasDeliveredUnread ?? false,
        };
      }),
      total: Number(count ?? 0),
      limit,
      offset,
    };
  }

  /**
   * Exporta contatos aplicando os MESMOS filtros da tela, porém no servidor e SEM
   * o cap de 250 do `listContactsPage`. É o caminho correto para exportar o
   * conjunto filtrado inteiro (a filtragem da UI é client-side sobre a página, o
   * que só enxergaria a página carregada). Teto de segurança em 200k linhas.
   */
  async exportContacts(
    scope: string | null,
    filters: {
      search?: string | null;
      category?: string | null;
      status?: string | null;
      valid?: string | null;
      optOut?: string | null;
      listId?: string | null;
    },
  ): Promise<
    Array<
      ContactRecord & {
        listNames: string[];
        listIds: string[];
        hasFailedMessage: boolean;
        hasDeliveredUnread: boolean;
      }
    >
  > {
    const args: unknown[] = [];
    const conds: string[] = [];
    if (scope !== null) {
      args.push(scope);
      conds.push(`c.client_id = $${args.length}`);
    }
    if (filters.category) {
      args.push(filters.category);
      conds.push(`c.category = $${args.length}`);
    }
    if (filters.status) {
      args.push(filters.status);
      conds.push(`c.record_status = $${args.length}`);
    }
    if (filters.valid === 'valid') {
      conds.push('c.is_valid = true');
    } else if (filters.valid === 'invalid') {
      conds.push('c.is_valid = false');
    }
    if (filters.optOut === 'out') {
      conds.push('c.is_opted_out = true');
    } else if (filters.optOut === 'in') {
      conds.push('c.is_opted_out = false');
    }
    if (filters.listId) {
      args.push(filters.listId);
      conds.push(
        `EXISTS (SELECT 1 FROM list_members lmf WHERE lmf.contact_id = c.id AND lmf.list_id = $${args.length})`,
      );
    }
    const term = String(filters.search ?? '').trim();
    if (term) {
      args.push(`%${term}%`);
      const p = args.length;
      conds.push(
        `(c.name ILIKE $${p} OR c.phone_e164 ILIKE $${p} OR c.email ILIKE $${p} OR c.client_name ILIKE $${p})`,
      );
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const rows = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT
        c.id, c.external_ref, c.client_name, c.first_name, c.last_name, c.name, c.category, c.record_status,
        c.phone_raw, c.phone_e164, c.phone_hash, c.email, c.attributes_json, c.is_valid, c.validation_error,
        c.is_opted_out, c.opted_out_at, c.opt_out_source, c.imported_at, c.created_at, c.updated_at,
        COALESCE(ARRAY_AGG(DISTINCT l.name ORDER BY l.name) FILTER (WHERE l.name IS NOT NULL), ARRAY[]::text[]) AS list_names,
        COALESCE(ARRAY_AGG(DISTINCT l.id) FILTER (WHERE l.id IS NOT NULL), ARRAY[]::text[]) AS list_ids
       FROM contacts c
       LEFT JOIN list_members lm ON lm.contact_id = c.id
       LEFT JOIN lists l ON l.id = lm.list_id
       ${where}
       GROUP BY c.id
       ORDER BY c.name ASC
       LIMIT 200000`,
      args,
    );

    const deliveryFlags = await this.fetchDeliveryFlags(rows.map((row) => String(row.id)));
    return rows.map((row) => {
      const id = String(row.id);
      const flags = deliveryFlags.get(id);
      return {
        ...mapContactRow(row),
        listNames: toStringArray(row.list_names),
        listIds: toStringArray(row.list_ids),
        hasFailedMessage: flags?.hasFailedMessage ?? false,
        hasDeliveredUnread: flags?.hasDeliveredUnread ?? false,
      };
    });
  }

  async listLists(scope: string | null = null) {
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
       ${scope !== null ? 'WHERE l.client_id = $1' : ''}
       GROUP BY l.id
       ORDER BY l.created_at DESC`,
      scope !== null ? [scope] : [],
    );

    return rows.map((row) => ({
      ...mapListRow(row),
      totalMembers: Number(row.total_members ?? 0),
      eligibleMembers: Number(row.eligible_members ?? 0),
      categories: parseListCategoryStats(row.category_stats),
    }));
  }

  async getList(id: string, scope: string | null = null) {
    const [row] = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT id, name, description, source_type, source_file_path, client_id, created_at, updated_at
       FROM lists
       WHERE id = $1`,
      [id],
    );
    if (!row || (scope !== null && (row.client_id ?? null) !== scope)) {
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

  async createList(
    input: { name: string; description?: string; clientId?: string | null; sourceType?: ListRecord['sourceType'] },
    actor: UserSession,
  ): Promise<ListRecord> {
    const timestamp = nowIso();
    const list: ListRecord = {
      id: newId(),
      clientId: writeClientId(actor, input.clientId),
      name: (input.name.trim() || 'Nova lista').slice(0, 200),
      description: cleanNullableText(input.description)?.slice(0, 2000) ?? null,
      sourceType: input.sourceType ?? 'manual',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.database.postgresQuery(
      `INSERT INTO lists (
        id, client_id, name, description, source_type, source_file_path, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        list.id,
        list.clientId ?? null,
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

  /** Edita nome/descrição de uma lista existente (escopado ao tenant). */
  async updateList(
    id: string,
    input: { name?: string; description?: string | null },
    actor: UserSession,
    requestedClientId: string | null = null,
  ): Promise<ListRecord> {
    const scope = resolveClientScope(actor, requestedClientId);
    const [row] = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT id, name, description, source_type, source_file_path, client_id, created_at, updated_at
       FROM lists WHERE id = $1`,
      [id],
    );
    if (!row || (scope !== null && (row.client_id ?? null) !== scope)) {
      throw new NotFoundException('Lista não encontrada');
    }

    const name = (
      input.name !== undefined ? input.name.trim() || String(row.name) : String(row.name)
    ).slice(0, 200);
    const description =
      input.description !== undefined
        ? (cleanNullableText(input.description)?.slice(0, 2000) ?? null)
        : cleanNullableText(toOptionalString(row.description));
    const updatedAt = nowIso();

    await this.database.postgresQuery(
      `UPDATE lists SET name = $1, description = $2, updated_at = $3 WHERE id = $4`,
      [name, description, updatedAt, id],
    );

    await this.audit.log({
      actorUserId: actor.id,
      action: 'list.updated',
      entityType: 'list',
      entityId: id,
      metadata: { name },
    });

    return { ...mapListRow(row), name, description, updatedAt };
  }

  /**
   * Exclui uma lista e suas associações.
   *
   * Por padrão os contatos são preservados (só a lista + `list_members` saem).
   * Com `deleteContacts`, também apaga os contatos que ficariam órfãos: só sai o
   * contato que é membro DESTA lista e que **não** está em nenhuma outra lista,
   * **não** tem `campaign_messages`, **não** tem `flow_responses` e **não** tem
   * opt-out (nem `opt_outs` nem `is_opted_out`). Histórico de campanha/flow
   * mantém o relatório íntegro (o export CSV por destinatário depende dele) e o
   * registro de opt-out nunca pode ser perdido — apagá-lo permitiria mensagear de
   * novo quem pediu para sair.
   *
   * Além dessas, uma guarda de tenant: o contato só sai se for do MESMO
   * `client_id` da lista. Telefone é único por tenant (ADR 0003: índice composto
   * `(COALESCE(client_id,''), phone_hash)`), então o mesmo número pode existir
   * como contatos distintos em tenants diferentes — o `client_id` é o dono de
   * verdade. Sem essa guarda, apagar a lista do tenant A poderia levar junto o
   * contato do tenant B que estivesse na lista sem outra lista e sem histórico.
   * Preservar a mais nunca é bug; apagar contato de outro tenant é.
   */
  async deleteList(
    id: string,
    actor: UserSession,
    requestedClientId: string | null = null,
    deleteContacts = false,
  ): Promise<{ id: string; contactsDeleted: number; contactsKept: number }> {
    const scope = resolveClientScope(actor, requestedClientId);
    const [row] = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT id, client_id FROM lists WHERE id = $1`,
      [id],
    );
    if (!row || (scope !== null && (row.client_id ?? null) !== scope)) {
      throw new NotFoundException('Lista não encontrada');
    }

    // Tenant dono da lista, reaproveitado do check de escopo acima (sem re-consultar).
    const listClientId = (row.client_id ?? null) as string | null;
    let contactsDeleted = 0;
    let contactsKept = 0;

    await this.database.postgresTransaction(async (client) => {
      const members = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM list_members WHERE list_id = $1`,
        [id],
      );
      const memberCount = Number(members.rows[0]?.count ?? '0');

      if (deleteContacts) {
        // Os contatos saem ANTES de `list_members`: as associações desta lista
        // são justamente o que identifica os candidatos. A FK
        // list_members.contact_id ON DELETE CASCADE limpa as associações deles.
        const deleted = await client.query<{ id: string }>(
          `DELETE FROM contacts c
             WHERE c.id IN (SELECT lm.contact_id FROM list_members lm WHERE lm.list_id = $1)
               AND c.client_id IS NOT DISTINCT FROM $2
               AND NOT EXISTS (
                 SELECT 1 FROM list_members other
                  WHERE other.contact_id = c.id AND other.list_id <> $1
               )
               AND NOT EXISTS (SELECT 1 FROM campaign_messages cm WHERE cm.contact_id = c.id)
               AND NOT EXISTS (SELECT 1 FROM flow_responses fr WHERE fr.contact_id = c.id)
               AND NOT EXISTS (SELECT 1 FROM opt_outs oo WHERE oo.contact_id = c.id)
               AND c.is_opted_out = false
           RETURNING c.id`,
          [id, listClientId],
        );
        contactsDeleted = deleted.rowCount ?? 0;
      }

      contactsKept = memberCount - contactsDeleted;

      await client.query(`DELETE FROM list_members WHERE list_id = $1`, [id]);
      await client.query(`DELETE FROM lists WHERE id = $1`, [id]);
    });

    await this.audit.log({
      actorUserId: actor.id,
      action: 'list.deleted',
      entityType: 'list',
      entityId: id,
      metadata: { deleteContacts, contactsDeleted, contactsKept },
    });

    return { id, contactsDeleted, contactsKept };
  }

  /** Remove um contato de uma lista (sem excluir o contato do tenant). */
  async removeListMember(
    listId: string,
    contactId: string,
    actor: UserSession,
    requestedClientId: string | null = null,
  ): Promise<{ removed: boolean }> {
    const scope = resolveClientScope(actor, requestedClientId);
    const [row] = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT id, client_id FROM lists WHERE id = $1`,
      [listId],
    );
    if (!row || (scope !== null && (row.client_id ?? null) !== scope)) {
      throw new NotFoundException('Lista não encontrada');
    }

    await this.database.postgresQuery(
      `DELETE FROM list_members WHERE list_id = $1 AND contact_id = $2`,
      [listId, contactId],
    );
    await this.database.postgresQuery(`UPDATE lists SET updated_at = $1 WHERE id = $2`, [
      nowIso(),
      listId,
    ]);

    await this.audit.log({
      actorUserId: actor.id,
      action: 'list.member_removed',
      entityType: 'list',
      entityId: listId,
      metadata: { contactId },
    });

    return { removed: true };
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

  /**
   * Dry-run da importação: sem escrever nada, projeta quantos contatos seriam
   * atualizados / criados / mantidos. Quando a coluna `id` está mapeada, roda em
   * MODO ATUALIZAÇÃO (casa por ID do cadastro); senão, é o modo clássico de
   * inserção (tudo entra como novo, com upsert por telefone no import real).
   */
  async planCsvImport(
    params: {
      fileName: string;
      content: Buffer;
      clientId?: string | null;
      mapping?: Partial<Record<CsvImportField, string | null>>;
    },
    actor: UserSession,
  ): Promise<{ mode: 'insert' | 'update'; total: number } & Partial<CsvUpdateSummary>> {
    const matrix = parseCsvMatrix(params.content);
    const { headers, records } = toColumnRecords(matrix);
    if (records.length === 0) {
      throw new BadRequestException('CSV sem linhas para importar');
    }

    const mapping = normalizeMapping(params.mapping, headers);
    const total = records.length;
    if (!mapping.id) {
      return { mode: 'insert', total };
    }

    const importClientId = writeClientId(actor, params.clientId ?? null);
    // Mesma classificação usada pelo job real => o "XXX a atualizar" do dry-run
    // bate exatamente com o resultado (inclui dedup de ID repetido e conflitos
    // de telefone).
    const { summary } = await this.classifyCsvUpdate(records, mapping, importClientId);
    return { mode: 'update', total, ...summary };
  }

  /**
   * Passada única de classificação do modo atualização, compartilhada pelo dry-run
   * (`planCsvImport`) e pelo job real (`processCsvUpdateJob`) — garante que a
   * projeção e o resultado nunca divirjam. Não escreve nada: só lê contatos por ID,
   * resolve o registro final de cada linha e decide atualizar / criar / manter /
   * pular por conflito. Reserva os `phone_hash` novos num set único (nada foi
   * persistido ainda) para prever colisões com a UNIQUE (client_id, phone_hash).
   */
  private async classifyCsvUpdate(
    records: Array<Record<string, string>>,
    mapping: Record<CsvImportField, string | null>,
    importClientId: string | null,
  ): Promise<{ summary: CsvUpdateSummary; inserts: ContactRecord[]; updates: ContactRecord[] }> {
    const existingById = await this.loadContactsById(records, mapping.id as string, importClientId);
    const inserts: ContactRecord[] = [];
    const updates: ContactRecord[] = [];
    const reserved = new Set<string>();
    let updated = 0;
    let created = 0;
    let unchanged = 0;
    let conflicts = 0;
    let invalid = 0;

    const phoneHashTaken = async (phoneHash: string, excludeId: string | null): Promise<boolean> => {
      if (reserved.has(phoneHash)) {
        return true;
      }
      const rows = await this.database.postgresQuery<{ id: string }>(
        `SELECT id FROM contacts
         WHERE phone_hash = $1 AND COALESCE(client_id, '') = COALESCE($2, '')
           ${excludeId ? 'AND id <> $3' : ''}
         LIMIT 1`,
        excludeId ? [phoneHash, importClientId, excludeId] : [phoneHash, importClientId],
      );
      return rows.length > 0;
    };

    for (const row of records) {
      const timestamp = nowIso();
      const id = pickMappedValue(row, mapping.id);
      const existing = id ? existingById.get(id) : undefined;

      if (!existing) {
        // Linha órfã (ID em branco ou inexistente no tenant) => novo contato.
        const contact = createNewContact(
          buildCreateInputFromRow(row, mapping, importClientId),
          normalizePhone(pickMappedValue(row, mapping.phone)),
          timestamp,
        );
        // Guarda de colisão para TODOS (inclusive inválidos): várias linhas sem
        // telefone compartilham hash('') e violariam a UNIQUE, abortando o lote.
        if (await phoneHashTaken(contact.phoneHash, null)) {
          conflicts += 1;
        } else {
          reserved.add(contact.phoneHash);
          inserts.push(contact);
          created += 1;
          if (!contact.isValid) invalid += 1;
        }
      } else {
        const next = buildUpdatedContactFromRow(existing, row, mapping, timestamp);
        if (!contactBusinessFieldsChanged(existing, next)) {
          unchanged += 1;
        } else if (
          next.phoneHash !== existing.phoneHash &&
          (await phoneHashTaken(next.phoneHash, existing.id))
        ) {
          conflicts += 1;
        } else {
          reserved.add(next.phoneHash);
          updates.push(next);
          // Reidrata o mapa: se o mesmo ID reaparecer, diferencia contra a versão
          // já atualizada (2ª ocorrência idêntica => "sem mudança").
          existingById.set(existing.id, next);
          updated += 1;
          if (!next.isValid) invalid += 1;
        }
      }
    }

    return { summary: { updated, created, unchanged, conflicts, invalid }, inserts, updates };
  }

  /** Carrega os contatos existentes (por ID) do arquivo, escopados ao tenant do import. */
  private async loadContactsById(
    records: Array<Record<string, string>>,
    idHeader: string,
    importClientId: string | null,
  ): Promise<Map<string, ContactRecord>> {
    const ids = [...new Set(records.map((row) => pickMappedValue(row, idHeader)).filter(Boolean))];
    const map = new Map<string, ContactRecord>();
    if (ids.length === 0) {
      return map;
    }
    const rows = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT ${CONTACT_COLUMNS} FROM contacts
       WHERE id = ANY($1::text[]) AND COALESCE(client_id, '') = COALESCE($2, '')`,
      [ids, importClientId],
    );
    for (const contact of rows.map(mapContactRow)) {
      map.set(contact.id, contact);
    }
    return map;
  }

  async startCsvImport(
    params: {
      listName: string;
      fileName: string;
      content: Buffer;
      clientId?: string | null;
      mapping?: Partial<Record<CsvImportField, string | null>>;
      defaults?: CsvImportDefaults;
      overwriteExisting?: boolean;
    },
    actor: UserSession,
  ): Promise<CsvImportJob> {
    const matrix = parseCsvMatrix(params.content);
    const { headers, records } = toColumnRecords(matrix);
    if (records.length === 0) {
      throw new BadRequestException('CSV sem linhas para importar');
    }

    const mapping = normalizeMapping(params.mapping, headers);
    // Coluna `id` mapeada => atualização em massa (casa por ID do cadastro).
    const mode: 'insert' | 'update' = mapping.id ? 'update' : 'insert';
    if (mode === 'update') {
      if (!mapping.id) {
        throw new BadRequestException('Mapeie a coluna de ID do cadastro para atualizar em massa');
      }
    } else if ((!mapping.firstName && !mapping.name) || !mapping.phone) {
      throw new BadRequestException('Mapeie telefone e pelo menos nome ou nome completo antes de importar');
    }

    const defaults = normalizeImportDefaults(params.defaults);
    const jobId = newId();
    const job: CsvImportJob = {
      id: jobId,
      status: 'queued',
      mode,
      fileName: params.fileName,
      listName: params.listName.trim() || params.fileName.replace(/\.[^.]+$/, ''),
      totalRows: records.length,
      processedRows: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      error: null,
    };

    this.importJobs.set(jobId, job);
    const fileSha256 = createHash('sha256').update(params.content).digest('hex');
    queueMicrotask(() => {
      if (mode === 'update') {
        void this.processCsvUpdateJob(
          jobId,
          {
            fileName: params.fileName,
            clientId: params.clientId ?? null,
            fileSha256,
            records,
            mapping,
          },
          actor,
        );
        return;
      }
      void this.processCsvImportJob(
        jobId,
        {
          fileName: params.fileName,
          listName: job.listName,
          clientId: params.clientId ?? null,
          fileSha256,
          records,
          mapping,
          defaults,
          overwriteExisting: params.overwriteExisting !== false,
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
      clientId?: string | null;
      fileSha256: string;
      records: Array<Record<string, string>>;
      mapping: Record<CsvImportField, string | null>;
      defaults: Required<CsvImportDefaults>;
      overwriteExisting: boolean;
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
    // Tenant dos registros importados: cliente => o próprio; Collos => o tenant
    // ativo (seletor da topbar) se informado, senão nenhum (escopo compartilhado).
    const importClientId = writeClientId(actor, params.clientId ?? null);
    const list: ListRecord = {
      id: newId(),
      clientId: importClientId,
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
    let skippedRows = 0;
    try {
      await this.database.postgresQuery(
        `INSERT INTO lists (
          id, client_id, name, description, source_type, source_file_path, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          list.id,
          list.clientId ?? null,
          list.name,
          list.description ?? null,
          list.sourceType,
          list.sourceFilePath ?? null,
          list.createdAt,
          list.updatedAt,
        ],
      );

      // Dedup do import é POR TENANT: só reaproveita contatos do mesmo tenant do
      // import (COALESCE trata nulo como o pool compartilhado). Isso mantém o
      // isolamento e casa com a unicidade composta (client_id, phone_hash).
      const existingContacts = (
        await this.database.postgresQuery<Record<string, unknown>>(
          `SELECT
            id, external_ref, client_name, first_name, last_name, name, category, record_status,
            phone_raw, phone_e164, phone_hash, email, attributes_json, is_valid, validation_error,
            is_opted_out, opted_out_at, opt_out_source, imported_at, created_at, updated_at
           FROM contacts WHERE COALESCE(client_id, '') = COALESCE($1, '')`,
          [importClientId],
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

        const writeMemberships = async (
          client: PoolClient,
          memberships: ListMemberRecord[],
        ): Promise<void> => {
          for (const membership of memberships) {
            await client.query(
              `INSERT INTO list_members (id, list_id, contact_id, created_at)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (list_id, contact_id) DO NOTHING`,
              [membership.id, membership.listId, membership.contactId, membership.createdAt],
            );
          }
        };

        try {
          await this.database.postgresTransaction(async (client) => {
            for (const contact of contactsToInsert) {
              await insertContactPg(client, contact);
            }

            for (const contact of contactsToUpdate) {
              await updateContactPg(client, contact);
            }

            await writeMemberships(client, membershipsToInsert);
          });
        } catch (error) {
          if (!isUniqueViolation(error)) {
            throw error;
          }

          // Rede de proteção: uma única colisão de telefone abortava a transação
          // e, com ela, a importação inteira (lotes de 1000 linhas). Aqui o lote é
          // refeito linha a linha: as linhas em conflito viram `skippedRows` e o
          // resto entra normalmente. Caminho degradado — só roda após falha.
          const failedContactIds = new Set<string>();
          for (const contact of contactsToInsert) {
            try {
              await this.database.postgresTransaction((client) => insertContactPg(client, contact));
            } catch (rowError) {
              if (!isUniqueViolation(rowError)) {
                throw rowError;
              }
              failedContactIds.add(contact.id);
              skippedRows += 1;
              if (contact.isValid) {
                validRows -= 1;
              } else {
                invalidRows -= 1;
              }
            }
          }

          for (const contact of contactsToUpdate) {
            try {
              await this.database.postgresTransaction((client) => updateContactPg(client, contact));
            } catch (rowError) {
              if (!isUniqueViolation(rowError)) {
                throw rowError;
              }
              // O contato continua no banco (e na lista) com os dados antigos;
              // só a sobrescrita não pôde ser aplicada. Segue como duplicado.
            }
          }

          // Só associa à lista o que de fato existe no banco (FK contact_id).
          const survivors = membershipsToInsert.filter(
            (membership) => !failedContactIds.has(membership.contactId),
          );
          await this.database.postgresTransaction((client) => writeMemberships(client, survivors));
        }
      };

      for (let index = 0; index < params.records.length; index += 1) {
        const row = params.records[index];
        const rawPhone = pickMappedValue(row, params.mapping.phone);
        const normalized = normalizePhone(rawPhone);
        // A chave de dedup TEM que ser o mesmo hash que vai para o banco
        // (`phone_e164` sem o '+', igual ao `createNewContact`). Com o antigo
        // fallback `|| rawPhone`, linhas cujo telefone não tem nenhum dígito
        // ("-", "não informado") eram procuradas por hash(texto) mas gravadas com
        // hash(''), furavam o dedup e estouravam a UNIQUE (client_id, phone_hash),
        // derrubando a importação inteira.
        const phoneHash = hash(normalized.phoneE164.replace(/^\+/, ''));
        // Sem nenhum dígito no telefone não existe contato possível: todas essas
        // linhas colapsam em hash('') e só uma poderia existir por tenant. Pula e
        // reporta em `skippedRows` em vez de fundir pessoas distintas num contato
        // fantasma (ou abortar o lote).
        if (!normalized.phoneE164) {
          skippedRows += 1;
          continue;
        }
        const existingContact = contactsByPhoneHash.get(phoneHash);
        const rowTimestamp = nowIso();
        const nextStatus = normalizeRecordStatus(
          pickMappedValue(row, params.mapping.status) || params.defaults.status,
        );
        const attributes = collectAttributes(row, params.mapping);

        const payload = {
          clientId: importClientId,
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

        // overwriteExisting: quando o telefone já existe no tenant, decide se os
        // dados do arquivo (mais novos) viram os principais (sobrescreve) ou se o
        // contato existente é preservado e apenas vinculado à nova lista.
        const contact = existingContact
          ? params.overwriteExisting
            ? updateExistingContact(existingContact, payload, normalized, rowTimestamp)
            : existingContact
          : createNewContact(payload, normalized, rowTimestamp);

        if (existingContact) {
          duplicateRows += 1;
          if (params.overwriteExisting) {
            batchContactsToUpdate.push(contact);
          }
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
        skippedRows,
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
          skipped_rows, field_mapping_json, defaults_json, status, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          importRecord.id,
          importRecord.listId,
          importRecord.fileName,
          importRecord.fileSha256,
          importRecord.totalRows,
          importRecord.validRows,
          importRecord.invalidRows,
          importRecord.duplicateRows,
          importRecord.skippedRows,
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
            skippedRows,
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

  /**
   * MODO ATUALIZAÇÃO EM MASSA: casa cada linha pelo ID do cadastro (estável mesmo
   * quando o telefone muda). Contato existente => atualiza só os campos presentes;
   * linha órfã (ID em branco ou inexistente no tenant) => cria como novo contato.
   * Não cria lista nem grava em `imports` (não há lista associada). Colisões de
   * telefone (constraint UNIQUE por tenant) são puladas e contadas, sem abortar.
   */
  private async processCsvUpdateJob(
    jobId: string,
    params: {
      fileName: string;
      clientId?: string | null;
      fileSha256: string;
      records: Array<Record<string, string>>;
      mapping: Record<CsvImportField, string | null>;
    },
    actor: UserSession,
  ): Promise<void> {
    const job = this.importJobs.get(jobId);
    if (!job) {
      return;
    }

    updateImportJob(job, { status: 'running', processedRows: 0, updatedAt: nowIso() });

    const importClientId = writeClientId(actor, params.clientId ?? null);

    try {
      // Mesma classificação do dry-run: garante que o resultado bate com o que foi
      // prometido ao usuário. Já resolve colisões de phone_hash e ID repetido.
      const { summary, inserts, updates } = await this.classifyCsvUpdate(
        params.records,
        params.mapping,
        importClientId,
      );

      const BATCH = 500;
      let processed = 0;
      const writeInBatches = async (
        contacts: ContactRecord[],
        write: (client: PoolClient, contact: ContactRecord) => Promise<void>,
      ) => {
        for (let i = 0; i < contacts.length; i += BATCH) {
          const chunk = contacts.slice(i, i + BATCH);
          await this.database.postgresTransaction(async (client) => {
            for (const contact of chunk) {
              await write(client, contact);
            }
          });
          processed += chunk.length;
          updateImportJob(job, { processedRows: processed, updatedAt: nowIso() });
          await yieldToEventLoop();
        }
      };

      await writeInBatches(inserts, insertContactPg);
      await writeInBatches(updates, updateContactPg);

      updateImportJob(job, {
        status: 'completed',
        processedRows: params.records.length,
        updateSummary: summary,
        updatedAt: nowIso(),
      });

      try {
        await this.audit.log({
          actorUserId: actor.id,
          action: 'contacts.updated_csv',
          entityType: 'contact',
          entityId: jobId,
          metadata: { fileName: params.fileName, total: params.records.length, ...summary },
        });
      } catch {
        // Auditoria não bloqueia a conclusão da atualização.
      }
    } catch (error) {
      updateImportJob(job, {
        status: 'failed',
        error: error instanceof Error ? error.message : 'Falha ao atualizar contatos por CSV',
        updatedAt: nowIso(),
      });
    }
  }

  async createContact(input: ContactInput, actor: UserSession) {
    const timestamp = nowIso();
    const normalized = normalizePhone(String(input.phone ?? ''));
    // Tenant do novo contato: cliente => o próprio; Collos => o informado (ou nenhum).
    const scopedInput = { ...input, clientId: writeClientId(actor, input.clientId) };
    const contact = createNewContact(scopedInput, normalized, timestamp);

    await this.database.postgresTransaction(async (client) => {
      await ensurePhoneIsUniqueInDatabase(client, contact.phoneHash, contact.clientId ?? null);
      await ensureListIdsExistInDatabase(client, input.listIds, resolveClientScope(actor, input.clientId));
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

  /**
   * Ingestão de contatos via API pública (token do tenant). Faz upsert por
   * phone_hash e garante a associação à lista. Escopado ao clientId do token:
   * a lista precisa pertencer ao tenant e contatos de outro tenant são pulados.
   */
  async apiIngestContacts(
    listId: string,
    rows: Array<{
      name?: string;
      firstName?: string;
      lastName?: string;
      phone?: string;
      email?: string | null;
      category?: string | null;
    }>,
    clientId: string,
  ): Promise<{
    listId: string;
    received: number;
    inserted: number;
    updated: number;
    skipped: number;
    invalid: number;
  }> {
    const [listRow] = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT id, client_id FROM lists WHERE id = $1`,
      [listId],
    );
    if (!listRow || (listRow.client_id ?? null) !== clientId) {
      throw new NotFoundException('Lista não encontrada');
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException('Envie ao menos um contato em "contacts"');
    }
    if (rows.length > 5000) {
      throw new BadRequestException('Máximo de 5000 contatos por requisição');
    }

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let invalid = 0;

    await this.database.postgresTransaction(async (client) => {
      for (const row of rows) {
        const rawPhone = String(row.phone ?? '').trim();
        if (!rawPhone) {
          invalid += 1;
          continue;
        }
        const normalized = normalizePhone(rawPhone);
        const phoneHash = hash((normalized.phoneE164 || rawPhone).replace(/^\+/, ''));
        const timestamp = nowIso();
        const input: ContactInput = {
          clientId,
          firstName: row.firstName,
          lastName: row.lastName ?? null,
          name: row.name,
          phone: rawPhone,
          email: row.email ?? null,
          category: row.category ?? null,
        };

        // Lookup POR TENANT: telefone de outro tenant é invisível aqui (entra
        // como novo contato deste tenant). Isso fecha o oráculo de enumeração
        // cross-tenant — a resposta não distingue "existe em outro tenant".
        const existingRows = await client.query<Record<string, unknown>>(
          `SELECT
            id, client_id, external_ref, client_name, first_name, last_name, name, category, record_status,
            phone_raw, phone_e164, phone_hash, email, attributes_json, is_valid, validation_error,
            is_opted_out, opted_out_at, opt_out_source, imported_at, created_at, updated_at
           FROM contacts WHERE phone_hash = $1 AND COALESCE(client_id, '') = COALESCE($2, '')`,
          [phoneHash, clientId],
        );
        const existing = existingRows.rows[0] ? mapContactRow(existingRows.rows[0]) : null;

        let contactId: string;
        if (existing) {
          const merged = updateExistingContact(existing, input, normalized, timestamp);
          await updateContactPg(client, merged);
          contactId = existing.id;
          updated += 1;
        } else {
          const contact = createNewContact(input, normalized, timestamp);
          await insertContactPg(client, contact);
          contactId = contact.id;
          inserted += 1;
        }

        await client.query(
          `INSERT INTO list_members (id, list_id, contact_id, created_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (list_id, contact_id) DO NOTHING`,
          [newId(), listId, contactId, timestamp],
        );
      }

      await client.query(`UPDATE lists SET updated_at = $1 WHERE id = $2`, [nowIso(), listId]);
    });

    return { listId, received: rows.length, inserted, updated, skipped, invalid };
  }

  async updateContact(
    id: string,
    input: ContactInput,
    actor: UserSession,
    requestedClientId: string | null = null,
  ) {
    let updatedContact: ContactRecord | undefined;

    const scope = resolveClientScope(actor, requestedClientId);
    await this.database.postgresTransaction(async (client) => {
      const existing = await getContactByIdFromDatabase(client, id);
      if (!existing || (scope !== null && (existing.clientId ?? null) !== scope)) {
        throw new NotFoundException('Contato não encontrado');
      }

      const normalized = normalizePhone(String(input.phone ?? existing.phoneRaw));
      const nextPhoneHash = hash((normalized.phoneE164 || existing.phoneE164).replace(/^\+/, ''));
      await ensurePhoneIsUniqueInDatabase(client, nextPhoneHash, existing.clientId ?? null, id);

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
        await ensureListIdsExistInDatabase(client, input.listIds, scope);
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
    const scope = resolveClientScope(actor);
    await this.database.postgresTransaction(async (client) => {
      const existing = await getContactByIdFromDatabase(client, id);
      if (!existing || (scope !== null && (existing.clientId ?? null) !== scope)) {
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

    const scope = resolveClientScope(actor);
    let affected = 0;
    let matchedContactIds: string[] = [];

    await this.database.postgresTransaction(async (client) => {
      // Restringe a ação em massa aos contatos do escopo do usuário.
      const scopedRows = await client.query<{ id: string }>(
        `SELECT id FROM contacts WHERE id = ANY($1) AND ($2::text IS NULL OR client_id = $2)`,
        [contactIds, scope],
      );
      const existingIds = scopedRows.rows.map((row) => row.id);
      if (existingIds.length === 0) {
        throw new NotFoundException('Nenhum contato encontrado');
      }

      matchedContactIds = existingIds;
      affected = existingIds.length;
      const timestamp = nowIso();

      if (input.action === 'assign_list' || input.action === 'remove_list') {
        if (!input.listId) {
          throw new BadRequestException('Informe a lista');
        }
        await ensureListIdsExistInDatabase(client, [input.listId], scope);
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
        case 'remove_list':
          await client.query(
            `DELETE FROM list_members WHERE list_id = $1 AND contact_id = ANY($2::text[])`,
            [input.listId!, existingIds],
          );
          break;
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

  /**
   * Mescla contatos duplicados em um único "keeper" (registro principal com os
   * dados corretos, escolhido pelo usuário). Re-aponta memberships de lista (com
   * dedup por lista), histórico de mensagens, respostas de flow e opt-outs para o
   * keeper; consolida o estado de opt-out (nunca perde uma supressão); e remove os
   * perdedores. Escopado por tenant — não mescla entre tenants diferentes.
   */
  async mergeContacts(keeperId: string, loserIds: string[], actor: UserSession) {
    const keeper = String(keeperId ?? '').trim();
    const losers = [
      ...new Set((loserIds ?? []).map((value) => String(value ?? '').trim()).filter(Boolean)),
    ].filter((id) => id !== keeper);

    if (!keeper) {
      throw new BadRequestException('Informe o contato principal (keeper)');
    }
    if (losers.length === 0) {
      throw new BadRequestException('Selecione ao menos dois contatos para mesclar');
    }
    if (losers.length > 100) {
      throw new BadRequestException('Máximo de 100 contatos por mesclagem');
    }

    const scope = resolveClientScope(actor);
    const allIds = [keeper, ...losers];
    let mergedContact: ContactRecord | undefined;

    await this.database.postgresTransaction(async (client) => {
      // opted_out_at chega como Date (TIMESTAMPTZ sem type parser customizado).
      const { rows } = await client.query<{
        id: string;
        client_id: string | null;
        is_opted_out: boolean;
        opted_out_at: string | Date | null;
        opt_out_source: string | null;
      }>(
        `SELECT id, client_id, is_opted_out, opted_out_at, opt_out_source
         FROM contacts
         WHERE id = ANY($1::text[]) AND ($2::text IS NULL OR client_id = $2)
         FOR UPDATE`,
        [allIds, scope],
      );

      if (rows.length !== allIds.length) {
        throw new NotFoundException('Um ou mais contatos não foram encontrados');
      }
      // Isolamento: todos os contatos precisam ser do mesmo tenant.
      const tenants = new Set(rows.map((row) => row.client_id ?? ''));
      if (tenants.size > 1) {
        throw new BadRequestException('Não é possível mesclar contatos de tenants diferentes');
      }

      const now = nowIso();

      // 1) list_members: mantém uma membership por lista (preferindo a do keeper),
      // apaga as demais do grupo e re-aponta as sobreviventes para o keeper, sem
      // violar UNIQUE(list_id, contact_id).
      await client.query(
        `DELETE FROM list_members
         WHERE contact_id = ANY($1::text[])
           AND id NOT IN (
             SELECT DISTINCT ON (list_id) id FROM list_members
             WHERE contact_id = ANY($1::text[])
             ORDER BY list_id, (contact_id = $2) DESC, id
           )`,
        [allIds, keeper],
      );
      await client.query(`UPDATE list_members SET contact_id = $1 WHERE contact_id = ANY($2::text[])`, [
        keeper,
        losers,
      ]);

      // 2) Histórico e supressões (colunas contact_id sem FK): re-aponta ao keeper.
      await client.query(`UPDATE campaign_messages SET contact_id = $1 WHERE contact_id = ANY($2::text[])`, [
        keeper,
        losers,
      ]);
      await client.query(`UPDATE flow_responses SET contact_id = $1 WHERE contact_id = ANY($2::text[])`, [
        keeper,
        losers,
      ]);
      await client.query(`UPDATE opt_outs SET contact_id = $1 WHERE contact_id = ANY($2::text[])`, [
        keeper,
        losers,
      ]);

      // 3) Consolida opt-out: se qualquer contato do grupo estava suprimido, o
      // keeper permanece/torna-se suprimido (nunca perde um opt-out na mesclagem).
      const optedOut = rows.filter((row) => row.is_opted_out);
      if (optedOut.length > 0) {
        const earliestDate = optedOut
          .map((row) => row.opted_out_at)
          .filter((value): value is string | Date => Boolean(value))
          .map((value) => new Date(value))
          .filter((date) => !Number.isNaN(date.getTime()))
          .reduce<Date | null>((min, date) => (!min || date < min ? date : min), null);
        const earliest = earliestDate ? earliestDate.toISOString() : now;
        const source =
          rows.find((row) => row.id === keeper && row.is_opted_out)?.opt_out_source ??
          optedOut[0].opt_out_source ??
          'merge';
        await client.query(
          `UPDATE contacts
           SET is_opted_out = true,
               opted_out_at = COALESCE(opted_out_at, $2),
               opt_out_source = COALESCE(opt_out_source, $3),
               updated_at = $4
           WHERE id = $1`,
          [keeper, earliest, source, now],
        );
      }

      // 4) Remove os perdedores e marca o keeper como atualizado.
      await client.query(`DELETE FROM contacts WHERE id = ANY($1::text[])`, [losers]);
      await client.query(`UPDATE contacts SET updated_at = $2 WHERE id = $1`, [keeper, now]);

      mergedContact = (await getContactByIdFromDatabase(client, keeper)) ?? undefined;
    });

    await this.audit.log({
      actorUserId: actor.id,
      action: 'contacts.merge',
      entityType: 'contact',
      entityId: keeper,
      metadata: { keeperId: keeper, mergedIds: losers, mergedCount: losers.length },
    });

    return { keeperId: keeper, mergedCount: losers.length, contact: mergedContact };
  }

  async setOptOut(contactId: string, actor: UserSession, source: OptOutRecord['source'] = 'manual') {
    const timestamp = nowIso();
    const scope = resolveClientScope(actor);
    await this.database.postgresTransaction(async (client) => {
      const contact = await getContactByIdFromDatabase(client, contactId);
      if (!contact || (scope !== null && (contact.clientId ?? null) !== scope)) {
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
    const scope = resolveClientScope(actor);
    await this.database.postgresTransaction(async (client) => {
      const contact = await getContactByIdFromDatabase(client, contactId);
      if (!contact || (scope !== null && (contact.clientId ?? null) !== scope)) {
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
    // Campos com alias curto exigem igualdade EXATA do header, senão capturam
    // colunas por substring: `id` pegaria "cidade"/"validade"; `firstName` (alias
    // "nome") pegaria "nome_completo" e corromperia o round-trip export→import
    // (nome completo duplicado como firstName). O `name` continua por substring
    // para casar "nome completo", "contato", etc.
    const exactMatchFields: CsvImportField[] = ['id', 'firstName', 'lastName'];
    const match = normalizedHeaders.find(({ normalized }) =>
      FIELD_ALIASES[field.key].some((alias) => {
        const normalizedAlias = normalizeHeaderAlias(alias);
        return exactMatchFields.includes(field.key)
          ? normalized === normalizedAlias
          : normalized.includes(normalizedAlias);
      }),
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

// Colunas derivadas/somente-leitura emitidas pela exportação de contatos. Não têm
// campo de destino na importação: precisam ser IGNORADAS (e não viram atributos),
// senão um round-trip export→import poluiria `attributes_json` e marcaria todo
// contato como "alterado". Mantido em sincronia com EXPORT_HEADERS do frontend
// (apps/web/app/contacts/page.tsx).
const RESERVED_EXPORT_HEADERS = new Set(
  ['valido', 'opt_out', 'situacao_falha', 'situacao_nao_lida', 'listas', 'criado_em', 'atualizado_em'].map(
    normalizeHeaderAlias,
  ),
);

const collectAttributes = (
  row: Record<string, string>,
  mapping: Record<CsvImportField, string | null>,
): Record<string, string> => {
  const mappedHeaders = new Set(Object.values(mapping).filter(Boolean));
  return Object.fromEntries(
    Object.entries(row)
      .filter(
        ([key, value]) =>
          !mappedHeaders.has(key) &&
          !RESERVED_EXPORT_HEADERS.has(normalizeHeaderAlias(key)) &&
          value.trim() !== '',
      )
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
    clientId: input.clientId ?? null,
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

/**
 * Monta o `ContactInput` de uma linha CSV no MODO ATUALIZAÇÃO: só carrega valores
 * de colunas efetivamente preenchidas (célula vazia => `undefined`), para que o
 * `updateExistingContact` preserve o dado atual em vez de zerá-lo. `attributes`
 * mescla os extras da linha sobre os já existentes.
 */
const buildUpdateInputFromRow = (
  existing: ContactRecord,
  row: Record<string, string>,
  mapping: Record<CsvImportField, string | null>,
): ContactInput => {
  const pick = (field: CsvImportField): string | undefined =>
    pickMappedValue(row, mapping[field]) || undefined;
  const extraAttributes = collectAttributes(row, mapping);

  return {
    clientName: pick('clientName'),
    firstName: pick('firstName'),
    lastName: pick('lastName'),
    name: pick('name'),
    phone: pick('phone'),
    category: pick('category'),
    email: pick('email'),
    externalRef: pick('externalRef'),
    recordStatus: pick('status'),
    attributes: Object.keys(extraAttributes).length
      ? { ...existing.attributes, ...extraAttributes }
      : undefined,
  };
};

/** `ContactInput` de uma linha órfã (ID não encontrado) no modo atualização: vira novo contato. */
const buildCreateInputFromRow = (
  row: Record<string, string>,
  mapping: Record<CsvImportField, string | null>,
  importClientId: string | null,
): ContactInput => ({
  clientId: importClientId,
  clientName: pickMappedValue(row, mapping.clientName) || null,
  firstName: pickMappedValue(row, mapping.firstName) || undefined,
  lastName: pickMappedValue(row, mapping.lastName) || null,
  name: pickMappedValue(row, mapping.name) || undefined,
  phone: pickMappedValue(row, mapping.phone) || '',
  category: pickMappedValue(row, mapping.category) || null,
  email: pickMappedValue(row, mapping.email) || null,
  externalRef: pickMappedValue(row, mapping.externalRef) || null,
  recordStatus: pickMappedValue(row, mapping.status) || 'active',
  attributes: collectAttributes(row, mapping),
});

/** Aplica uma linha CSV sobre um contato existente e devolve o registro atualizado. */
const buildUpdatedContactFromRow = (
  existing: ContactRecord,
  row: Record<string, string>,
  mapping: Record<CsvImportField, string | null>,
  timestamp: string,
): ContactRecord => {
  const rawPhone = pickMappedValue(row, mapping.phone);
  const normalized = normalizePhone(rawPhone || existing.phoneRaw);
  return updateExistingContact(existing, buildUpdateInputFromRow(existing, row, mapping), normalized, timestamp);
};

/**
 * Compara os campos de negócio de dois contatos (ignora `importedAt`/`updatedAt`,
 * que mudam sempre). Usado para contar quantos contatos de fato foram alterados.
 */
const contactBusinessFieldsChanged = (before: ContactRecord, after: ContactRecord): boolean =>
  (before.externalRef ?? null) !== (after.externalRef ?? null) ||
  (before.clientName ?? null) !== (after.clientName ?? null) ||
  before.firstName !== after.firstName ||
  (before.lastName ?? null) !== (after.lastName ?? null) ||
  before.name !== after.name ||
  (before.category ?? null) !== (after.category ?? null) ||
  before.recordStatus !== after.recordStatus ||
  before.phoneE164 !== after.phoneE164 ||
  before.phoneHash !== after.phoneHash ||
  (before.email ?? null) !== (after.email ?? null) ||
  before.isValid !== after.isValid ||
  JSON.stringify(before.attributes ?? {}) !== JSON.stringify(after.attributes ?? {});

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
  clientId: (toOptionalString(row.client_id) ?? null) as string | null,
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
  hasFailedMessage: false,
  hasDeliveredUnread: false,
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
        id, client_id, external_ref, client_name, first_name, last_name, name, category, record_status,
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

/**
 * Violação de UNIQUE do Postgres (SQLSTATE 23505) — usada para degradar a
 * importação linha a linha em vez de perder o lote inteiro.
 */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';

// Unicidade de telefone é POR TENANT: o mesmo número pode existir em tenants
// diferentes (COALESCE trata client_id nulo como o pool compartilhado).
const ensurePhoneIsUniqueInDatabase = (
  database: Pick<PoolClient, 'query'>,
  phoneHash: string,
  clientId: string | null,
  excludeContactId?: string,
) =>
  database
    .query(
      excludeContactId
        ? `SELECT id FROM contacts WHERE phone_hash = $1 AND COALESCE(client_id, '') = COALESCE($2, '') AND id != $3 LIMIT 1`
        : `SELECT id FROM contacts WHERE phone_hash = $1 AND COALESCE(client_id, '') = COALESCE($2, '') LIMIT 1`,
      excludeContactId ? [phoneHash, clientId, excludeContactId] : [phoneHash, clientId],
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
  // Obrigatório de propósito: null = sem restrição (só super-admin). Forçar o
  // chamador a decidir evita reabrir a brecha cross-tenant por omissão.
  scope: string | null,
) => {
  const ids = [...new Set((listIds ?? []).filter(Boolean))];
  if (ids.length === 0) {
    return;
  }

  // Escopo por tenant: super-admin (scope null) vê todas; cliente só as próprias.
  const result = await database.query(
    'SELECT COUNT(*)::int AS count FROM lists WHERE id = ANY($1::text[]) AND ($2::text IS NULL OR client_id = $2)',
    [ids, scope],
  );
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
      id, client_id, external_ref, client_name, first_name, last_name, name, category, record_status,
      phone_raw, phone_e164, phone_hash, email, attributes_json, is_valid, validation_error,
      is_opted_out, opted_out_at, opt_out_source, imported_at, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
    [
      contact.id,
      contact.clientId ?? null,
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
