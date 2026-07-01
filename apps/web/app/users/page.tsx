'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell, useShell } from '../../components/app-shell';
import {
  Badge,
  BadgeText,
  EmptyState,
  ErrorBanner,
  Forbidden,
  Modal,
  SkeletonRows,
} from '../../components/ui';
import { apiRequest } from '../../lib/api';
import { ENTITY_STATUS, badgeFor } from '../../lib/badges';
import { fmtDateTime } from '../../lib/format';
import { ClientRecord, ROLE_LABELS, Role, isCollosRole } from '../../lib/session';

interface UserView {
  id: string;
  name: string;
  email: string;
  role: Role;
  clientId: string | null;
  clientName: string | null;
  status: 'active' | 'inactive';
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const ROLES: Role[] = ['super_admin', 'admin', 'client_admin', 'operator', 'viewer'];

type Draft = {
  name: string;
  email: string;
  role: Role;
  clientId: string;
  password: string;
  status: 'active' | 'inactive';
};

const emptyDraft = (): Draft => ({
  name: '',
  email: '',
  role: 'operator',
  clientId: '',
  password: '',
  status: 'active',
});

export default function UsersPage() {
  return (
    <AppShell title="Usuários">
      <UsersContent />
    </AppShell>
  );
}

function UsersContent() {
  const { session, clients } = useShell();
  const [users, setUsers] = useState<UserView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [editing, setEditing] = useState<UserView | 'new' | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    if (clientFilter) params.set('clientId', clientFilter);
    if (roleFilter) params.set('role', roleFilter);
    if (statusFilter) params.set('status', statusFilter);
    const query = params.toString();
    void apiRequest<UserView[]>(`/users${query ? `?${query}` : ''}`)
      .then((data) => {
        setUsers(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar usuários.');
        setLoading(false);
      });
  }, [search, clientFilter, roleFilter, statusFilter]);

  useEffect(() => {
    if (isCollosRole(session.role)) load();
  }, [load, session.role]);

  if (!isCollosRole(session.role)) {
    return <Forbidden />;
  }

  return (
    <>
      <div className="op-head">
        <div className="op-head-titles">
          <h1 className="op-title">Usuários</h1>
          <p className="op-sub">Acessos da operação Collos e dos clientes.</p>
        </div>
        <div className="op-actions">
          <button className="btn primary md" onClick={() => setEditing('new')}>
            Novo usuário
          </button>
        </div>
      </div>

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}

      <div className="toolbar">
        <div className="tb-search">
          <SearchIcon />
          <input
            placeholder="Buscar por nome ou e-mail"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <select className="flt" value={clientFilter} onChange={(e) => setClientFilter(e.target.value)}>
          <option value="">Todos os clientes</option>
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
            </option>
          ))}
        </select>
        <select className="flt" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
          <option value="">Todos os papéis</option>
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </select>
        <select className="flt" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">Todos os status</option>
          <option value="active">Ativo</option>
          <option value="inactive">Inativo</option>
        </select>
      </div>

      <div className="tbl-wrap">
        <table className="tbl dense">
          <thead>
            <tr>
              <th>Nome</th>
              <th>E-mail</th>
              <th>Cliente</th>
              <th>Papel</th>
              <th>Status</th>
              <th>Último login</th>
              <th>Criado em</th>
              <th></th>
            </tr>
          </thead>
          {loading ? (
            <SkeletonRows rows={6} cols={8} />
          ) : (
            <tbody>
              {users.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <EmptyState title="Nenhum usuário encontrado" />
                  </td>
                </tr>
              ) : (
                users.map((user) => (
                  <tr key={user.id}>
                    <td className="cell-strong">{user.name}</td>
                    <td className="cell-mono">{user.email}</td>
                    <td className="cell-sub">{user.clientName ?? '—'}</td>
                    <td>
                      <BadgeText label={ROLE_LABELS[user.role]} cls="brand-soft" />
                    </td>
                    <td>
                      <Badge def={badgeFor(ENTITY_STATUS, user.status)} />
                    </td>
                    <td className="cell-mono">{fmtDateTime(user.lastLoginAt)}</td>
                    <td className="cell-mono">{fmtDateTime(user.createdAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button className="icon-act" title="Editar" onClick={() => setEditing(user)}>
                          <EditIcon />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          )}
        </table>
      </div>

      {editing ? (
        <UserModal
          user={editing === 'new' ? null : editing}
          clients={clients}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      ) : null}
    </>
  );
}

function UserModal({
  user,
  clients,
  onClose,
  onSaved,
}: {
  user: UserView | null;
  clients: ClientRecord[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(
    user
      ? {
          name: user.name,
          email: user.email,
          role: user.role,
          clientId: user.clientId ?? '',
          password: '',
          status: user.status,
        }
      : emptyDraft(),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const clientDisabled = isCollosRole(draft.role);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        name: draft.name,
        email: draft.email,
        role: draft.role,
        clientId: clientDisabled ? null : draft.clientId || null,
        status: draft.status,
      };
      if (draft.password) {
        payload.password = draft.password;
      }
      await apiRequest(user ? `/users/${user.id}` : '/users', {
        method: user ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao salvar usuário.');
      setSaving(false);
    }
  };

  return (
    <Modal
      title={user ? 'Editar usuário' : 'Novo usuário'}
      onClose={onClose}
      footer={
        <>
          {error ? (
            <span className="left" style={{ color: 'var(--danger)', fontSize: 13 }}>
              {error}
            </span>
          ) : null}
          <button className="btn tertiary md" onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button className="btn primary md" onClick={submit} disabled={saving}>
            {saving ? 'Salvando…' : 'Salvar'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="field col-2">
          <label>
            Nome <span className="req">*</span>
          </label>
          <input className="input" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="field col-2">
          <label>
            E-mail <span className="req">*</span>
          </label>
          <input
            className="input"
            type="email"
            value={draft.email}
            onChange={(e) => set({ email: e.target.value })}
          />
        </div>
        <div className="field">
          <label>
            Papel <span className="req">*</span>
          </label>
          <select
            className="input"
            value={draft.role}
            onChange={(e) => set({ role: e.target.value as Role })}
          >
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>
            Cliente {clientDisabled ? null : <span className="req">*</span>}
          </label>
          <select
            className="input"
            value={clientDisabled ? '' : draft.clientId}
            disabled={clientDisabled}
            onChange={(e) => set({ clientId: e.target.value })}
          >
            <option value="">{clientDisabled ? 'Não se aplica (Collos)' : 'Selecione um cliente'}</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>
            Senha {user ? null : <span className="req">*</span>}
          </label>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            placeholder={user ? 'Deixe em branco para manter' : 'Mínimo 8 caracteres'}
            value={draft.password}
            onChange={(e) => set({ password: e.target.value })}
          />
          {user ? <span className="hint">Preencha apenas para redefinir a senha.</span> : null}
        </div>
        <div className="field">
          <label>Status</label>
          <select
            className="input"
            value={draft.status}
            onChange={(e) => set({ status: e.target.value as Draft['status'] })}
          >
            <option value="active">Ativo</option>
            <option value="inactive">Inativo</option>
          </select>
        </div>
      </div>
    </Modal>
  );
}

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}
