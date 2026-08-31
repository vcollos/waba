import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { DatabaseService } from '../database/database.service';
import { nowIso } from '../database/helpers';
import { UserSession } from '../database/types';

interface OverviewList {
  id: string;
  name: string;
  clientId: string | null;
  sourceType: string;
  memberCount: number;
}

interface OverviewCampaign {
  id: string;
  name: string;
  clientId: string | null;
  status: string;
}

interface OverviewTemplate {
  id: string;
  name: string;
  languageCode: string;
  integrationId: string;
  integrationName: string;
  /** Override por template (etiqueta); null = herda os tenants da integração. */
  clientId: string | null;
  /**
   * Tenants que enxergam o modelo: só o da etiqueta quando existe, senão TODOS
   * os vinculados à integração — uma conta WABA compartilhada expõe o modelo a
   * mais de um tenant (ADR 0009).
   */
  effectiveClientIds: string[];
}

interface OverviewClient {
  id: string;
  name: string;
}

/**
 * Ferramenta administrativa (Collos) para organizar dados entre tenants:
 * transferir listas (com seus contatos) e campanhas de um tenant para outro.
 * Toda a superfície é restrita a super_admin/admin no controller.
 */
@Injectable()
export class AdminTenantsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async overview(): Promise<{
    clients: OverviewClient[];
    lists: OverviewList[];
    campaigns: OverviewCampaign[];
    templates: OverviewTemplate[];
  }> {
    const listRows = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT
        l.id,
        l.name,
        l.client_id,
        l.source_type,
        (SELECT COUNT(*) FROM list_members lm WHERE lm.list_id = l.id)::int AS member_count
       FROM lists l
       ORDER BY l.name ASC`,
    );
    // Quem enxerga o modelo: a etiqueta quando existe, senão todos os tenants
    // vinculados à integração — a conta WABA pode ser compartilhada (ADR 0009).
    const templateRows = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT
        t.id,
        t.name,
        t.language_code,
        t.integration_id,
        i.name AS integration_name,
        t.client_id,
        CASE
          WHEN t.client_id IS NOT NULL THEN ARRAY[t.client_id]
          ELSE COALESCE(
            (SELECT array_agg(link.client_id ORDER BY link.created_at)
             FROM integration_clients link
             WHERE link.integration_id = t.integration_id),
            ARRAY[]::text[]
          )
        END AS effective_client_ids
       FROM templates t
       LEFT JOIN integrations i ON i.id = t.integration_id
       ORDER BY t.name ASC`,
    );
    const state = await this.database.readMeta();

    return {
      clients: state.clients.map((client) => ({ id: client.id, name: client.name })),
      lists: listRows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        clientId: (row.client_id as string | null) ?? null,
        sourceType: String(row.source_type),
        memberCount: Number(row.member_count ?? 0),
      })),
      campaigns: state.campaigns.map((campaign) => ({
        id: campaign.id,
        name: campaign.name,
        clientId: campaign.clientId ?? null,
        status: campaign.status,
      })),
      templates: templateRows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        languageCode: String(row.language_code),
        integrationId: String(row.integration_id),
        integrationName: (row.integration_name as string | null) ?? '',
        clientId: (row.client_id as string | null) ?? null,
        effectiveClientIds: (row.effective_client_ids as string[] | null) ?? [],
      })),
    };
  }

  /** Resolve o tenant alvo (null = pool compartilhado); valida se existe. */
  private async resolveTarget(targetClientId: string | null): Promise<string | null> {
    const target = (targetClientId ?? '').trim() || null;
    if (target === null) {
      return null;
    }
    const state = await this.database.readMeta();
    if (!state.clients.some((client) => client.id === target)) {
      throw new BadRequestException('Tenant de destino não encontrado');
    }
    return target;
  }

  /**
   * Transfere listas para um tenant, movendo TAMBÉM os contatos membros.
   * Contatos cujo telefone já existe no tenant de destino (unicidade por tenant)
   * são pulados para não violar o índice composto.
   */
  async transferLists(
    listIds: string[],
    targetClientId: string | null,
    actor: UserSession,
  ): Promise<{ lists: number; contactsMoved: number; contactsReused: number }> {
    const ids = [...new Set((listIds ?? []).filter(Boolean))];
    if (ids.length === 0) {
      throw new BadRequestException('Selecione ao menos uma lista');
    }
    const target = await this.resolveTarget(targetClientId);

    let contactsMoved = 0;
    let contactsReused = 0;
    await this.database.postgresTransaction(async (client) => {
      const existingLists = await client.query<{ id: string }>(
        `SELECT id FROM lists WHERE id = ANY($1::text[])`,
        [ids],
      );
      if (existingLists.rowCount !== ids.length) {
        throw new NotFoundException('Uma ou mais listas não foram encontradas');
      }

      // Dedup por "keeper": para cada telefone do lote, um único contato canônico
      // no destino — o já existente lá, senão o menor id entre os membros do lote.
      // Isso evita violar o índice composto tanto por colisão com o destino quanto
      // por colisão INTRA-LOTE (dois membros de tenants diferentes, mesmo telefone).
      await client.query(
        `CREATE TEMP TABLE _batch_members ON COMMIT DROP AS
           SELECT DISTINCT c.id AS contact_id, c.phone_hash
           FROM list_members lm JOIN contacts c ON c.id = lm.contact_id
           WHERE lm.list_id = ANY($1::text[])`,
        [ids],
      );
      await client.query(
        `CREATE TEMP TABLE _keepers ON COMMIT DROP AS
           SELECT ph AS phone_hash,
             COALESCE(
               (SELECT id FROM contacts
                 WHERE COALESCE(client_id, '') = COALESCE($1, '') AND phone_hash = ph
                 LIMIT 1),
               (SELECT contact_id FROM _batch_members bm WHERE bm.phone_hash = ph
                 ORDER BY contact_id LIMIT 1)
             ) AS keeper_id
           FROM (SELECT DISTINCT phone_hash AS ph FROM _batch_members) x`,
        [target],
      );

      // Move para o destino apenas os contatos "keeper" que ainda não estão lá.
      const movedRes = await client.query(
        `UPDATE contacts SET client_id = $1, updated_at = $2
         WHERE id IN (SELECT keeper_id FROM _keepers)
           AND COALESCE(client_id, '') <> COALESCE($1, '')`,
        [target, nowIso()],
      );
      contactsMoved += movedRes.rowCount ?? 0;

      // Re-aponta membros não-keeper para o keeper (dedup). Remove antes as
      // associações que colidiriam com o UNIQUE(list_id, contact_id).
      await client.query(
        `DELETE FROM list_members lm
         USING _batch_members bm, _keepers k
         WHERE lm.list_id = ANY($1::text[]) AND lm.contact_id = bm.contact_id
           AND bm.phone_hash = k.phone_hash AND lm.contact_id <> k.keeper_id
           AND EXISTS (
             SELECT 1 FROM list_members lm2 WHERE lm2.list_id = lm.list_id AND lm2.contact_id = k.keeper_id
           )`,
        [ids],
      );
      const reusedRes = await client.query(
        `UPDATE list_members lm SET contact_id = k.keeper_id
         FROM _batch_members bm, _keepers k
         WHERE lm.list_id = ANY($1::text[]) AND lm.contact_id = bm.contact_id
           AND bm.phone_hash = k.phone_hash AND lm.contact_id <> k.keeper_id`,
        [ids],
      );
      contactsReused += reusedRes.rowCount ?? 0;

      await client.query(`UPDATE lists SET client_id = $1, updated_at = $2 WHERE id = ANY($3::text[])`, [
        target,
        nowIso(),
        ids,
      ]);
    });

    void this.audit
      .log({
        actorUserId: actor.id,
        action: 'admin.tenant.lists_transferred',
        entityType: 'list',
        entityId: ids.join(','),
        metadata: { targetClientId: target, lists: ids.length, contactsMoved, contactsReused },
      })
      .catch(() => undefined);

    return { lists: ids.length, contactsMoved, contactsReused };
  }

  /** Reatribui o tenant de campanhas (retag no app_state). */
  async transferCampaigns(
    campaignIds: string[],
    targetClientId: string | null,
    actor: UserSession,
  ): Promise<{ campaigns: number }> {
    const ids = [...new Set((campaignIds ?? []).filter(Boolean))];
    if (ids.length === 0) {
      throw new BadRequestException('Selecione ao menos uma campanha');
    }
    const target = await this.resolveTarget(targetClientId);

    let matched = 0;
    await this.database.write((state) => {
      for (const campaign of state.campaigns) {
        if (ids.includes(campaign.id)) {
          campaign.clientId = target;
          campaign.updatedAt = nowIso();
          matched += 1;
        }
      }
    });
    if (matched === 0) {
      throw new NotFoundException('Nenhuma campanha encontrada');
    }

    void this.audit
      .log({
        actorUserId: actor.id,
        action: 'admin.tenant.campaigns_transferred',
        entityType: 'campaign',
        entityId: ids.join(','),
        metadata: { targetClientId: target, campaigns: matched },
      })
      .catch(() => undefined);

    return { campaigns: matched };
  }

  /**
   * Etiqueta modelos com um tenant (override sobre o tenant da integração).
   * `clientId` nulo/vazio LIMPA a etiqueta: o modelo volta a herdar o tenant da
   * conta WABA. O override sobrevive ao re-sync (chaveado por metaTemplateId).
   */
  async transferTemplates(
    templateIds: string[],
    targetClientId: string | null,
    actor: UserSession,
  ): Promise<{ templates: number }> {
    const ids = [...new Set((templateIds ?? []).filter(Boolean))];
    if (ids.length === 0) {
      throw new BadRequestException('Selecione ao menos um modelo');
    }
    // resolveTarget devolve null para vazio — aqui isso significa "herdar".
    const target = await this.resolveTarget(targetClientId);

    // Guardamos o valor ANTERIOR de cada etiqueta: sem ele, uma etiquetagem
    // errada seria irreversível e invisível no histórico (achado do Téo).
    const updated = await this.database.postgresQuery<{ id: string; old_client_id: string | null }>(
      `WITH prev AS (
         SELECT id, client_id AS old_client_id FROM templates WHERE id = ANY($2::text[])
       )
       UPDATE templates t SET client_id = $1
       FROM prev
       WHERE t.id = prev.id
       RETURNING t.id, prev.old_client_id`,
      [target, ids],
    );
    if (updated.length === 0) {
      throw new NotFoundException('Nenhum modelo encontrado');
    }

    void this.audit
      .log({
        actorUserId: actor.id,
        action: 'admin.tenant.templates_tagged',
        entityType: 'template',
        entityId: ids.join(','),
        metadata: {
          targetClientId: target,
          templates: updated.length,
          previous: updated.map((row) => ({ id: row.id, clientId: row.old_client_id ?? null })),
        },
      })
      .catch(() => undefined);

    return { templates: updated.length };
  }
}
