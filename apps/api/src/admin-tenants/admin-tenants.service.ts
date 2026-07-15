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
}
