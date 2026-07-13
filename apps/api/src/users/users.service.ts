import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../common/password';
import { DatabaseService } from '../database/database.service';
import { ClientRecord, EntityStatus, Role, UserRecord, isCollosRole } from '../database/types';

const ROLES: Role[] = ['super_admin', 'admin', 'client_admin', 'operator', 'viewer'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

export interface UserInput {
  name?: string;
  email?: string;
  role?: Role;
  clientIds?: string[];
  password?: string;
  status?: EntityStatus;
}

export interface UserView {
  id: string;
  name: string;
  email: string;
  role: Role;
  clientIds: string[];
  clients: Array<{ id: string; name: string }>;
  status: EntityStatus;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserFilters {
  search?: string;
  clientId?: string;
  role?: string;
  status?: string;
}

const clean = (value?: string | null): string => (value ?? '').trim();

@Injectable()
export class UsersService {
  constructor(private readonly database: DatabaseService) {}

  async list(filters: UserFilters = {}): Promise<UserView[]> {
    const [users, clients] = await Promise.all([
      this.database.listUsers(),
      this.database.listClients(),
    ]);
    const byId = new Map(clients.map((client) => [client.id, client]));
    const search = clean(filters.search).toLowerCase();

    return users
      .filter((user) => {
        if (filters.clientId && !(user.clientIds ?? []).includes(filters.clientId)) return false;
        if (filters.role && user.role !== filters.role) return false;
        if (filters.status && user.status !== filters.status) return false;
        if (
          search &&
          !user.name.toLowerCase().includes(search) &&
          !user.email.toLowerCase().includes(search)
        ) {
          return false;
        }
        return true;
      })
      .map((user) => this.toView(user, byId))
      .sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'));
  }

  async create(input: UserInput): Promise<UserView> {
    const name = clean(input.name);
    const email = clean(input.email).toLowerCase();
    const role = input.role;

    if (!name) throw new BadRequestException('Nome é obrigatório');
    if (!email || !EMAIL_RE.test(email)) throw new BadRequestException('E-mail inválido');
    if (!role || !ROLES.includes(role)) throw new BadRequestException('Papel inválido');

    const existing = await this.database.findUserByEmail(email);
    if (existing) throw new BadRequestException('Já existe um usuário com este e-mail');

    const password = input.password ?? '';
    if (password.length < MIN_PASSWORD) {
      throw new BadRequestException(`A senha deve ter ao menos ${MIN_PASSWORD} caracteres`);
    }

    const clientIds = await this.resolveClientIds(role, input.clientIds);
    const timestamp = new Date().toISOString();
    const record: UserRecord = {
      id: `usr_${randomUUID()}`,
      clientIds,
      name,
      email,
      passwordHash: hashPassword(password),
      role,
      status: input.status === 'inactive' ? 'inactive' : 'active',
      lastLoginAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.database.saveUser(record);
    return this.toView(record, await this.clientsById());
  }

  async update(id: string, input: UserInput): Promise<UserView> {
    const existing = await this.database.getUser(id);
    if (!existing) throw new NotFoundException('Usuário não encontrado');

    const name = input.name !== undefined ? clean(input.name) : existing.name;
    if (!name) throw new BadRequestException('Nome é obrigatório');

    let email = existing.email;
    if (input.email !== undefined) {
      email = clean(input.email).toLowerCase();
      if (!EMAIL_RE.test(email)) throw new BadRequestException('E-mail inválido');
      const collision = await this.database.findUserByEmail(email);
      if (collision && collision.id !== id) {
        throw new BadRequestException('Já existe um usuário com este e-mail');
      }
    }

    const role = input.role ?? existing.role;
    if (!ROLES.includes(role)) throw new BadRequestException('Papel inválido');

    const clientIds =
      input.role !== undefined || input.clientIds !== undefined
        ? await this.resolveClientIds(role, input.clientIds ?? existing.clientIds)
        : existing.clientIds ?? [];

    let passwordHash = existing.passwordHash;
    if (input.password !== undefined && input.password !== '') {
      if (input.password.length < MIN_PASSWORD) {
        throw new BadRequestException(`A senha deve ter ao menos ${MIN_PASSWORD} caracteres`);
      }
      passwordHash = hashPassword(input.password);
    }

    const record: UserRecord = {
      ...existing,
      name,
      email,
      role,
      clientIds,
      passwordHash,
      status: input.status ?? existing.status,
      updatedAt: new Date().toISOString(),
    };

    await this.database.saveUser(record);
    return this.toView(record, await this.clientsById());
  }

  /**
   * Papéis Collos não têm tenant (lista vazia). Papéis de cliente exigem 1+
   * tenants válidos e distintos.
   */
  private async resolveClientIds(role: Role, clientIds?: string[]): Promise<string[]> {
    if (isCollosRole(role)) {
      return [];
    }
    const normalized = [...new Set((clientIds ?? []).map(clean).filter(Boolean))];
    if (normalized.length === 0) {
      throw new BadRequestException('Selecione ao menos um cliente para este papel');
    }
    for (const clientId of normalized) {
      const client = await this.database.getClient(clientId);
      if (!client) {
        throw new BadRequestException('Cliente não encontrado');
      }
    }
    return normalized;
  }

  private async clientsById(): Promise<Map<string, ClientRecord>> {
    const clients = await this.database.listClients();
    return new Map(clients.map((client) => [client.id, client]));
  }

  private toView(user: UserRecord, byId: Map<string, ClientRecord>): UserView {
    const clientIds = user.clientIds ?? [];
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      clientIds,
      clients: clientIds.map((id) => ({ id, name: byId.get(id)?.name ?? id })),
      status: user.status,
      lastLoginAt: user.lastLoginAt ?? null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
