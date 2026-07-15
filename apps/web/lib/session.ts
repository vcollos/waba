'use client';

export type Role = 'super_admin' | 'admin' | 'client_admin' | 'operator' | 'viewer';

export interface UserSession {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** Tenants que o usuário pode acessar. Vazio = Collos (todos). */
  clientIds: string[];
}

export interface ClientRecord {
  id: string;
  name: string;
  legalName?: string | null;
  cnpj?: string | null;
  billingEmail?: string | null;
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
}

export const COLLOS_ROLES: Role[] = ['super_admin', 'admin'];
export const isCollosRole = (role: Role): boolean => COLLOS_ROLES.includes(role);

/** Pode executar ações operacionais (criar campanha, sincronizar modelos, etc.). Viewer só lê. */
export const canWrite = (role: Role): boolean => role !== 'viewer';

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super admin',
  admin: 'Admin',
  client_admin: 'Admin do cliente',
  operator: 'Operador',
  viewer: 'Visualizador',
};

export interface NavItem {
  href: string;
  label: string;
  /** Cor do nav-dot (token DS). */
  dot: string;
  /** Visível apenas para papéis Collos. */
  collosOnly?: boolean;
}

/** Navegação na ordem do DESIGN.md §1 (11 itens Collos / 7 itens cliente). */
export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', dot: 'var(--uni-vinho-medio)' },
  { href: '/clients', label: 'Clientes', dot: 'var(--uni-roxo)', collosOnly: true },
  { href: '/users', label: 'Usuários', dot: 'var(--uni-ciano)', collosOnly: true },
  { href: '/integrations', label: 'Integrações', dot: 'var(--uni-pessego)', collosOnly: true },
  { href: '/contacts', label: 'Contatos', dot: 'var(--uni-lima)' },
  { href: '/lists', label: 'Listas', dot: 'var(--uni-ciano)' },
  { href: '/library', label: 'Modelos', dot: 'var(--uni-roxo)' },
  { href: '/campaigns', label: 'Campanhas', dot: 'var(--uni-vinho-medio)' },
  { href: '/results', label: 'Resultados', dot: 'var(--uni-goiaba)' },
  { href: '/billing', label: 'Cobrança', dot: 'var(--uni-lima)' },
  { href: '/audit', label: 'Auditoria', dot: 'var(--uni-pessego)', collosOnly: true },
  { href: '/tenant-organizer', label: 'Organização', dot: 'var(--uni-roxo)', collosOnly: true },
];

export const navForRole = (role: Role): NavItem[] =>
  NAV_ITEMS.filter((item) => !item.collosOnly || isCollosRole(role));

const ACTIVE_CLIENT_KEY = 'waba_active_client';

export const readActiveClientId = (): string | null =>
  typeof window === 'undefined' ? null : window.localStorage.getItem(ACTIVE_CLIENT_KEY);

export const writeActiveClientId = (clientId: string | null): void => {
  if (typeof window === 'undefined') {
    return;
  }
  if (clientId) {
    window.localStorage.setItem(ACTIVE_CLIENT_KEY, clientId);
  } else {
    window.localStorage.removeItem(ACTIVE_CLIENT_KEY);
  }
};

export const initials = (name?: string | null): string => {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return '?';
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};
