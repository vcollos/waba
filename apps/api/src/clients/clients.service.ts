import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
}

const clean = (value?: string | null): string | null => {
  const normalized = value?.trim();
  return normalized ? normalized : null;
};

@Injectable()
export class ClientsService {
  constructor(private readonly database: DatabaseService) {}

  /** Tenants visíveis: Collos vê todos; papel de cliente vê só o próprio. */
  async list(session: UserSession): Promise<ClientView[]> {
    const [clients, integrations] = await Promise.all([
      this.database.listClients(),
      this.database.listIntegrationsInDatabase(),
    ]);

    const countByClient = new Map<string, number>();
    for (const integration of integrations) {
      if (integration.clientId) {
        countByClient.set(integration.clientId, (countByClient.get(integration.clientId) ?? 0) + 1);
      }
    }

    const allowed = sessionClientIds(session);
    const visible = isCollosRole(session.role)
      ? clients
      : clients.filter((client) => allowed.includes(client.id));

    return visible
      .map((client) => ({ ...client, integrationsCount: countByClient.get(client.id) ?? 0 }))
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
}
