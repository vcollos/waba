import { UserSession, isCollosRole } from '../database/types';

/**
 * Resolve o escopo de tenant efetivo para uma requisição.
 *
 * - Papéis de cliente (client_admin/operator/viewer) são SEMPRE forçados ao
 *   próprio clientId. Nunca conseguem ler/escrever dados de outro tenant, nem
 *   passando um clientId na query.
 * - Papéis Collos (super_admin/admin) veem tudo; o clientId informado (ex.: o
 *   seletor da topbar) vira um filtro opcional.
 *
 * Retorno:
 * - `null`  => sem filtro (todos os tenants). Só ocorre para Collos.
 * - string  => filtrar estritamente por esse clientId.
 *
 * Fail-closed: um usuário de cliente sem clientId recebe um escopo impossível
 * (`__none__`), então não enxerga nada.
 */
export const resolveClientScope = (
  session: UserSession,
  requestedClientId?: string | null,
): string | null => {
  if (isCollosRole(session.role)) {
    const requested = (requestedClientId ?? '').trim();
    return requested ? requested : null;
  }
  return session.clientId ?? '__none__';
};

/** True se o registro (com seu clientId) é visível dentro do escopo. */
export const isWithinScope = (
  scope: string | null,
  recordClientId?: string | null,
): boolean => scope === null || (recordClientId ?? null) === scope;

/**
 * clientId a gravar ao criar um registro:
 * - papel de cliente => sempre o próprio clientId (ignora o que vier no corpo);
 * - Collos => o clientId solicitado (ex.: seletor da topbar) ou null.
 */
export const writeClientId = (
  session: UserSession,
  requestedClientId?: string | null,
): string | null => {
  if (isCollosRole(session.role)) {
    const requested = (requestedClientId ?? '').trim();
    return requested ? requested : null;
  }
  return session.clientId ?? null;
};
