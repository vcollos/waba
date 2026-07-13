import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../common/password';
import { DatabaseService } from '../database/database.service';
import { EntityStatus, Role, UserRecord, isCollosRole } from '../database/types';

const ROLES: Role[] = ['super_admin', 'admin', 'client_admin', 'operator', 'viewer'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

export interface UserInput {
  name?: string;
  email?: string;
  role?: Role;
  clientId?: string | null;
  password?: string;
  status?: EntityStatus;
}

export interface UserView {
  id: string;
  name: string;
  email: string;
  role: Role;
  clientId: string | null;
  clientName: string | null;
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
    const clientName = (clientId?: string | null): string | null =>
      clientId ? clients.find((client) => client.id === clientId)?.name ?? null : null;

    const search = clean(filters.search).toLowerCase();

    return users
      .filter((user) => {
        if (filters.clientId && user.clientId !== filters.clientId) return false;
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
      .map((user) => this.toView(user, clientName(user.clientId)))
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

    const clientId = await this.resolveClientId(role, input.clientId);
    const timestamp = new Date().toISOString();
    const record: UserRecord = {
      id: `usr_${randomUUID()}`,
      clientId,
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
    return this.toView(record, await this.clientNameOf(clientId));
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

    const clientId =
      input.role !== undefined || input.clientId !== undefined
        ? await this.resolveClientId(role, input.clientId ?? existing.clientId)
        : existing.clientId ?? null;

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
      clientId,
      passwordHash,
      status: input.status ?? existing.status,
      updatedAt: new Date().toISOString(),
    };

    await this.database.saveUser(record);
    return this.toView(record, await this.clientNameOf(clientId));
  }

  /** Papéis Collos não têm tenant; papéis de cliente exigem um clientId válido. */
  private async resolveClientId(role: Role, clientId?: string | null): Promise<string | null> {
    if (isCollosRole(role)) {
      return null;
    }
    const normalized = clean(clientId).length ? clean(clientId) : null;
    if (!normalized) {
      throw new BadRequestException('Cliente é obrigatório para este papel');
    }
    const client = await this.database.getClient(normalized);
    if (!client) {
      throw new BadRequestException('Cliente não encontrado');
    }
    return normalized;
  }

  private async clientNameOf(clientId: string | null): Promise<string | null> {
    if (!clientId) return null;
    const client = await this.database.getClient(clientId);
    return client?.name ?? null;
  }

  private toView(user: UserRecord, clientName: string | null): UserView {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      clientId: user.clientId ?? null,
      clientName,
      status: user.status,
      lastLoginAt: user.lastLoginAt ?? null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
