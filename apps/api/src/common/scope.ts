import { UserSession, isCollosRole } from '../database/types';

/**
 * Tenants do usuário, tolerando tokens legados (pré multi-tenant) que carregam
 * `clientId` único em vez de `clientIds`. Evita que um token antigo resulte em
 * escopo vazio (usuário sem ver nada) até relogar.
 */
export const sessionClientIds = (session: UserSession): string[] => {
  if (Array.isArray(session.clientIds) && session.clientIds.length > 0) {
    return session.clientIds;
  }
  const legacy = (session as UserSession & { clientId?: string | null }).clientId;
  return legacy ? [legacy] : [];
};

/**
 * Resolve o tenant efetivo (ativo) de uma requisição.
 *
 * - Papéis Collos (super_admin/admin): veem tudo. `requestedClientId` (ex.: o
 *   seletor da topbar) vira filtro opcional → retorna esse clientId ou `null`.
 * - Papéis de cliente: operam UM tenant por vez, sempre dentro dos seus
 *   `clientIds`. O `requestedClientId` só é aceito se pertencer ao conjunto do
 *   usuário; caso contrário cai no primeiro tenant dele. Nunca acessa fora do
 *   próprio conjunto (não dá para burlar via ?clientId=).
 *
 * Retorno:
 * - `null`  => sem filtro (todos os tenants). Só ocorre para Collos.
 * - string  => filtrar estritamente por esse clientId.
 *
 * Fail-closed: cliente sem nenhum tenant recebe escopo impossível (`__none__`).
 */
export const resolveClientScope = (
  session: UserSession,
  requestedClientId?: string | null,
): string | null => {
  const requested = (requestedClientId ?? '').trim() || null;
  if (isCollosRole(session.role)) {
    return requested;
  }
  const allowed = sessionClientIds(session);
  if (requested && allowed.includes(requested)) {
    return requested;
  }
  return allowed[0] ?? '__none__';
};

/** True se o registro (com seu clientId) é visível dentro do escopo. */
export const isWithinScope = (
  scope: string | null,
  recordClientId?: string | null,
): boolean => scope === null || (recordClientId ?? null) === scope;

/**
 * clientId a gravar ao criar um registro:
 * - Collos => o tenant solicitado (seletor) ou null;
 * - cliente => o tenant ativo (solicitado se for dele, senão o primeiro).
 */
export const writeClientId = (
  session: UserSession,
  requestedClientId?: string | null,
): string | null => {
  const requested = (requestedClientId ?? '').trim() || null;
  if (isCollosRole(session.role)) {
    return requested;
  }
  const allowed = sessionClientIds(session);
  if (requested && allowed.includes(requested)) {
    return requested;
  }
  return allowed[0] ?? null;
};
