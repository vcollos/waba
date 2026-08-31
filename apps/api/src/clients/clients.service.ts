import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../common/audit.service';
import { sessionClientIds } from '../common/scope';
import { DatabaseService } from '../database/database.service';
import { ClientRecord, EntityStatus, UserSession, isCollosRole } from '../database/types';

export interface ClientInput {
  name?: string;
  legalName?: string | null;
  cnpj?: string | null;
  billingEmail?: string | null;
  status?: EntityStatus;
}

export interface ClientView extends ClientRecord {
  integrationsCount: number;
  /** Integrações WABA que este tenant pode usar (vínculo N:N). */
  integrationIds: string[];
}

const clean = (value?: string | null): string | null => {
  const normalized = value?.trim();
  return normalized ? normalized : null;
};

@Injectable()
export class ClientsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Tenants visíveis: Collos vê todos; papel de cliente vê só o próprio. */
  async list(session: UserSession): Promise<ClientView[]> {
    const [clients, links] = await Promise.all([
      this.database.listClients(),
      this.database.listClientIntegrationsInDatabase(),
    ]);

    // Uma integração compartilhada conta para TODOS os tenants vinculados.
    const integrationsByClient = new Map<string, string[]>();
    for (const link of links) {
      const current = integrationsByClient.get(link.clientId);
      if (current) {
        current.push(link.integrationId);
      } else {
        integrationsByClient.set(link.clientId, [link.integrationId]);
      }
    }

    const allowed = sessionClientIds(session);
    const visible = isCollosRole(session.role)
      ? clients
      : clients.filter((client) => allowed.includes(client.id));

    return visible
      .map((client) => {
        const integrationIds = integrationsByClient.get(client.id) ?? [];
        return { ...client, integrationIds, integrationsCount: integrationIds.length };
      })
      .sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'));
  }

  async create(input: ClientInput): Promise<ClientRecord> {
    const name = clean(input.name);
    if (!name) {
      throw new BadRequestException('Nome é obrigatório');
    }

    const timestamp = new Date().toISOString();
    const record: ClientRecord = {
      id: `cli_${randomUUID()}`,
      name,
      legalName: clean(input.legalName),
      cnpj: clean(input.cnpj),
      billingEmail: clean(input.billingEmail),
      status: input.status === 'inactive' ? 'inactive' : 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.database.saveClient(record);
    return record;
  }

  async update(id: string, input: ClientInput): Promise<ClientRecord> {
    const existing = await this.database.getClient(id);
    if (!existing) {
      throw new NotFoundException('Cliente não encontrado');
    }

    const name = input.name !== undefined ? clean(input.name) : existing.name;
    if (!name) {
      throw new BadRequestException('Nome é obrigatório');
    }

    const record: ClientRecord = {
      ...existing,
      name,
      legalName: input.legalName !== undefined ? clean(input.legalName) : existing.legalName,
      cnpj: input.cnpj !== undefined ? clean(input.cnpj) : existing.cnpj,
      billingEmail:
        input.billingEmail !== undefined ? clean(input.billingEmail) : existing.billingEmail,
      status: input.status ?? existing.status,
      updatedAt: new Date().toISOString(),
    };

    await this.database.saveClient(record);
    return record;
  }

  /**
   * Define o conjunto EXATO de integrações que este tenant pode usar.
   *
   * Toca SÓ os vínculos deste cliente: marcar a conta WABA compartilhada aqui
   * não a remove de nenhum outro tenant. Um vínculo só desaparece quando um
   * admin o desmarca nesta chamada — nunca por restart, deploy ou sync.
   */
  async setIntegrations(
    clientId: string,
    integrationIds: string[],
    actor: UserSession,
  ): Promise<ClientView> {
    const client = await this.database.getClient(clientId);
    if (!client) {
      throw new NotFoundException('Cliente não encontrado');
    }

    const known = new Set(
      (await this.database.listIntegrationsInDatabase()).map((integration) => integration.id),
    );
    const desired = [...new Set(integrationIds)].filter((id) => known.has(id));
    const links = await this.database.listClientIntegrationsInDatabase();
    const before = links
      .filter((link) => link.clientId === clientId)
      .map((link) => link.integrationId);

    await this.database.replaceClientIntegrationsForClient(clientId, desired, actor.id);

    void this.audit
      .log({
        actorUserId: actor.id,
        action: 'client.integrations_changed',
        entityType: 'client',
        entityId: clientId,
        metadata: { before, after: desired },
      })
      .catch(() => undefined);

    return { ...client, integrationIds: desired, integrationsCount: desired.length };
  }
}
