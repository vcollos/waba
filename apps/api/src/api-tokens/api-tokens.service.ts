import { randomBytes } from 'node:crypto';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../common/audit.service';
import { isWithinScope, resolveClientScope, writeClientId } from '../common/scope';
import { DatabaseService } from '../database/database.service';
import { hash, newId, nowIso } from '../database/helpers';
import { UserSession } from '../database/types';

export interface ApiTokenView {
  id: string;
  clientId: string | null;
  name: string;
  tokenPrefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const mapTokenRow = (row: Record<string, unknown>): ApiTokenView => ({
  id: String(row.id),
  clientId: (row.client_id as string | null) ?? null,
  name: String(row.name),
  tokenPrefix: String(row.token_prefix),
  lastUsedAt: (row.last_used_at as string | null) ?? null,
  revokedAt: (row.revoked_at as string | null) ?? null,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

@Injectable()
export class ApiTokensService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Tokens visíveis no escopo do usuário (cliente: do próprio tenant; Collos: todos ou filtrado). */
  async list(session: UserSession, requestedClientId?: string | null): Promise<ApiTokenView[]> {
    const scope = resolveClientScope(session, requestedClientId);
    const rows = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT id, client_id, name, token_prefix, last_used_at, revoked_at, created_at, updated_at
       FROM api_tokens
       ${scope !== null ? 'WHERE client_id = $1' : ''}
       ORDER BY created_at DESC`,
      scope !== null ? [scope] : [],
    );
    return rows.map(mapTokenRow);
  }

  /** Cria um token. O texto puro é retornado UMA vez (só o hash é persistido). */
  async create(
    input: { name: string; clientId?: string | null },
    actor: UserSession,
  ): Promise<ApiTokenView & { token: string }> {
    const clientId = writeClientId(actor, input.clientId);
    const raw = `wba_${randomBytes(24).toString('hex')}`;
    const timestamp = nowIso();
    const record = {
      id: newId(),
      clientId,
      name: input.name.trim() || 'Token de API',
      tokenPrefix: raw.slice(0, 12),
      tokenHash: hash(raw),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.database.postgresQuery(
      `INSERT INTO api_tokens (
        id, client_id, name, token_prefix, token_hash, last_used_at, revoked_at, created_by, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, $7, $8)`,
      [
        record.id,
        record.clientId ?? null,
        record.name,
        record.tokenPrefix,
        record.tokenHash,
        actor.id,
        record.createdAt,
        record.updatedAt,
      ],
    );

    await this.audit.log({
      actorUserId: actor.id,
      action: 'api_token.created',
      entityType: 'api_token',
      entityId: record.id,
      metadata: { name: record.name, clientId: record.clientId },
    });

    return {
      id: record.id,
      clientId: record.clientId,
      name: record.name,
      tokenPrefix: record.tokenPrefix,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      token: raw,
    };
  }

  /** Revoga um token (dentro do escopo do usuário). */
  async revoke(id: string, actor: UserSession): Promise<ApiTokenView> {
    const [row] = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT id, client_id, name, token_prefix, last_used_at, revoked_at, created_at, updated_at
       FROM api_tokens WHERE id = $1`,
      [id],
    );
    if (!row) {
      throw new NotFoundException('Token não encontrado');
    }
    const scope = resolveClientScope(actor);
    if (!isWithinScope(scope, (row.client_id as string | null) ?? null)) {
      throw new ForbiddenException('Token fora do seu escopo');
    }

    const timestamp = nowIso();
    await this.database.postgresQuery(
      `UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, $1), updated_at = $1 WHERE id = $2`,
      [timestamp, id],
    );

    await this.audit.log({
      actorUserId: actor.id,
      action: 'api_token.revoked',
      entityType: 'api_token',
      entityId: id,
    });

    return { ...mapTokenRow(row), revokedAt: (row.revoked_at as string | null) ?? timestamp, updatedAt: timestamp };
  }

  /** Resolve o tenant de um token puro (Authorization: Bearer) para o guard público. */
  async resolveClientId(rawToken: string): Promise<{ tokenId: string; clientId: string } | null> {
    const raw = rawToken.trim();
    if (!raw) {
      return null;
    }
    const [row] = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT id, client_id, revoked_at FROM api_tokens WHERE token_hash = $1`,
      [hash(raw)],
    );
    if (!row || row.revoked_at) {
      return null;
    }
    const clientId = (row.client_id as string | null) ?? null;
    if (!clientId) {
      // Token sem tenant não pode ingerir dados isolados.
      return null;
    }
    void this.database
      .postgresQuery(`UPDATE api_tokens SET last_used_at = $1 WHERE id = $2`, [nowIso(), row.id])
      .catch(() => undefined);
    return { tokenId: String(row.id), clientId };
  }
}
