'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { apiRequest, clearToken } from '../lib/api';
import {
  ClientRecord,
  NavItem,
  ROLE_LABELS,
  UserSession,
  initials,
  isCollosRole,
  navForRole,
  readActiveClientId,
  writeActiveClientId,
} from '../lib/session';

interface ShellContextValue {
  session: UserSession;
  clients: ClientRecord[];
  /** Tenant em foco. Collos: cliente selecionado ou null (todos). Cliente: próprio tenant. */
  scopeClientId: string | null;
  setScopeClientId: (clientId: string | null) => void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

export const useShell = (): ShellContextValue => {
  const value = useContext(ShellContext);
  if (!value) {
    throw new Error('useShell deve ser usado dentro de AppShell');
  }
  return value;
};

export function AppShell({ title, children }: { title: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<UserSession | null>(null);
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const me = await apiRequest<UserSession>('/auth/me');
        if (!active) return;
        setSession(me);
        // Todos os papéis carregam seus clientes (a API já devolve escopado).
        const clientList = await apiRequest<ClientRecord[]>('/clients');
        if (!active) return;
        setClients(clientList);
        const stored = readActiveClientId();
        if (isCollosRole(me.role)) {
          setSelectedClientId(stored && clientList.some((c) => c.id === stored) ? stored : null);
        } else {
          // Cliente opera um tenant por vez: o salvo (se for dele) ou o primeiro.
          const tenants = me.clientIds ?? [];
          setSelectedClientId(
            stored && tenants.includes(stored) ? stored : tenants[0] ?? null,
          );
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Falha ao carregar sessão');
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const logout = () => {
    clearToken();
    router.replace('/login');
  };

  const setScopeClientId = (clientId: string | null) => {
    setSelectedClientId(clientId);
    writeActiveClientId(clientId);
  };

  const contextValue = useMemo<ShellContextValue | null>(() => {
    if (!session) return null;
    return {
      session,
      clients,
      // Collos: seletor ou null (todos). Cliente: o tenant ativo (um dos seus).
      scopeClientId: selectedClientId,
      setScopeClientId,
    };
  }, [session, clients, selectedClientId]);

  if (error) {
    return (
      <div className="auth">
        <div className="auth-card">
          <div className="auth-error">{error}</div>
          <button className="btn secondary md" style={{ marginTop: 16 }} onClick={logout}>
            Voltar ao login
          </button>
        </div>
      </div>
    );
  }

  if (!session || !contextValue) {
    return <div className="auth"><div className="auth-card">Carregando…</div></div>;
  }

  const collos = isCollosRole(session.role);
  const items = navForRole(session.role);
  // Nome do tenant fixo quando o cliente tem exatamente um.
  const activeClientName = clients.find((c) => c.id === selectedClientId)?.name ?? clients[0]?.name ?? null;

  return (
    <ShellContext.Provider value={contextValue}>
      <div className="app">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <img
              className="sidebar-brand-mark"
              src="/brand/simbolo_comando_positivo.svg"
              alt="Collos"
            />
            <div className="sidebar-brand-meta">
              <span className="sidebar-brand-title">WABA Collos</span>
              <span className="sidebar-brand-sub">{collos ? 'Operação Collos' : 'Cliente'}</span>
            </div>
          </div>

          <nav className="nav">
            <div className="nav-group">
              {items.map((item) => (
                <NavLink key={item.href} item={item} active={pathname === item.href} />
              ))}
            </div>
          </nav>

          <div className="sidebar-footer">
            Plataforma multi-tenant de <strong>WhatsApp Business</strong> via APIs oficiais da Meta.
          </div>
        </aside>

        <div className="main">
          <div className="topbar">
            <div className="crumbs">
              <span>WABA Collos</span>
              <span className="crumb-sep">/</span>
              <span className="crumb-current">{title}</span>
            </div>

            <div className="topbar-actions">
              {collos ? (
                <div className="tb-client">
                  <ClientIcon />
                  <select
                    value={selectedClientId ?? ''}
                    onChange={(event) => setScopeClientId(event.target.value || null)}
                    aria-label="Cliente em foco"
                  >
                    <option value="">Todos os clientes</option>
                    {clients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : clients.length > 1 ? (
                <div className="tb-client">
                  <ClientIcon />
                  <select
                    value={selectedClientId ?? clients[0]?.id ?? ''}
                    onChange={(event) => setScopeClientId(event.target.value || null)}
                    aria-label="Tenant ativo"
                  >
                    {clients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : activeClientName ? (
                <div className="tb-client">
                  <ClientIcon />
                  {activeClientName}
                </div>
              ) : null}

              <div className="tb-divider" />

              <div className="tb-user">
                <div className="tb-avatar">{initials(session.name)}</div>
                <div className="tb-user-meta">
                  <span className="tb-user-name">{session.name}</span>
                  <span className="tb-user-role">{ROLE_LABELS[session.role]}</span>
                </div>
              </div>

              <button className="tb-iconbtn" onClick={logout} title="Sair" aria-label="Sair">
                <LogoutIcon />
              </button>
            </div>
          </div>

          <div className="content-scroll">
            <div className="content">{children}</div>
          </div>
        </div>
      </div>
    </ShellContext.Provider>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link href={item.href} className={active ? 'nav-item active' : 'nav-item'}>
      <span className="nav-dot" style={{ background: item.dot }} />
      {item.label}
    </Link>
  );
}

function ClientIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 21V8l9-5 9 5v13" />
      <path d="M9 21v-6h6v6" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}
