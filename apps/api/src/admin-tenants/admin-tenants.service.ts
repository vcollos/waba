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
  ): Promise<{ lists: number; contactsMoved: number; contactsSkipped: number }> {
    const ids = [...new Set((listIds ?? []).filter(Boolean))];
    if (ids.length === 0) {
      throw new BadRequestException('Selecione ao menos uma lista');
    }
    const target = await this.resolveTarget(targetClientId);

    let contactsMoved = 0;
    let contactsSkipped = 0;
    await this.database.postgresTransaction(async (client) => {
      for (const listId of ids) {
        const listRes = await client.query(`SELECT id FROM lists WHERE id = $1`, [listId]);
        if (listRes.rowCount === 0) {
          throw new NotFoundException(`Lista ${listId} não encontrada`);
        }

        // Membros que colidiriam com um contato já existente no tenant destino.
        const conflictRes = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM contacts c
           WHERE c.id IN (SELECT contact_id FROM list_members WHERE list_id = $2)
             AND EXISTS (
               SELECT 1 FROM contacts t
               WHERE COALESCE(t.client_id, '') = COALESCE($1, '')
                 AND t.phone_hash = c.phone_hash
                 AND t.id <> c.id
             )`,
          [target, listId],
        );
        contactsSkipped += Number(conflictRes.rows[0]?.count ?? 0);

        const movedRes = await client.query(
          `UPDATE contacts
           SET client_id = $1, updated_at = $2
           WHERE id IN (SELECT contact_id FROM list_members WHERE list_id = $3)
             AND NOT EXISTS (
               SELECT 1 FROM contacts t
               WHERE COALESCE(t.client_id, '') = COALESCE($1, '')
                 AND t.phone_hash = contacts.phone_hash
                 AND t.id <> contacts.id
             )`,
          [target, nowIso(), listId],
        );
        contactsMoved += movedRes.rowCount ?? 0;

        await client.query(`UPDATE lists SET client_id = $1, updated_at = $2 WHERE id = $3`, [
          target,
          nowIso(),
          listId,
        ]);
      }
    });

    void this.audit
      .log({
        actorUserId: actor.id,
        action: 'admin.tenant.lists_transferred',
        entityType: 'list',
        entityId: ids.join(','),
        metadata: { targetClientId: target, lists: ids.length, contactsMoved, contactsSkipped },
      })
      .catch(() => undefined);

    return { lists: ids.length, contactsMoved, contactsSkipped };
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
