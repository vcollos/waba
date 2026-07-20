'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell, useShell } from '../../components/app-shell';
import {
  Badge,
  EmptyState,
  ErrorBanner,
  Forbidden,
  Modal,
  SkeletonRows,
  usePagedRows,
} from '../../components/ui';
import { apiRequest } from '../../lib/api';
import { ENTITY_STATUS, badgeFor } from '../../lib/badges';
import { fmtDateTime, fmtInt } from '../../lib/format';
import { isCollosRole } from '../../lib/session';

interface ClientView {
  id: string;
  name: string;
  legalName: string | null;
  cnpj: string | null;
  billingEmail: string | null;
  status: 'active' | 'inactive';
  integrationsCount: number;
  createdAt: string;
  updatedAt: string;
}

interface Integration {
  id: string;
  name: string;
  clientId: string | null;
}

type Draft = {
  name: string;
  legalName: string;
  cnpj: string;
  billingEmail: string;
  status: 'active' | 'inactive';
};

const emptyDraft = (): Draft => ({
  name: '',
  legalName: '',
  cnpj: '',
  billingEmail: '',
  status: 'active',
});

export default function ClientsPage() {
  return (
    <AppShell title="Clientes">
      <ClientsContent />
    </AppShell>
  );
}

function ClientsContent() {
  const { session } = useShell();
  const [clients, setClients] = useState<ClientView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [editing, setEditing] = useState<ClientView | 'new' | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    void apiRequest<ClientView[]>('/clients')
      .then((data) => {
        setClients(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar clientes.');
        setLoading(false);
      });
    void apiRequest<Integration[]>('/integrations').then(setIntegrations).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (isCollosRole(session.role)) load();
  }, [load, session.role]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return clients.filter((client) => {
      if (statusFilter && client.status !== statusFilter) return false;
      if (term && !client.name.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [clients, search, statusFilter]);

  const { pageRows, pager } = usePagedRows(filtered, 'cliente(s)');

  if (!isCollosRole(session.role)) {
    return <Forbidden />;
  }

  return (
    <>
      <div className="op-head">
        <div className="op-head-titles">
          <h1 className="op-title">Clientes</h1>
          <p className="op-sub">Tenants Uniodonto operados pela Collos.</p>
        </div>
        <div className="op-actions">
          <button className="btn primary md" onClick={() => setEditing('new')}>
            Novo cliente
          </button>
        </div>
      </div>

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}

      <div className="toolbar">
        <div className="tb-search">
          <SearchIcon />
          <input
            placeholder="Buscar por nome"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
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
              <th>Razão social</th>
              <th>CNPJ</th>
              <th>E-mail de cobrança</th>
              <th>Status</th>
              <th className="num">Integrações</th>
              <th>Criado em</th>
              <th>Atualizado em</th>
              <th></th>
            </tr>
          </thead>
          {loading ? (
            <SkeletonRows rows={6} cols={9} />
          ) : (
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9}>
                    <EmptyState title="Nenhum cliente encontrado" />
                  </td>
                </tr>
              ) : (
                pageRows.map((client) => (
                  <tr key={client.id}>
                    <td className="cell-strong">{client.name}</td>
                    <td className="cell-sub">{client.legalName ?? '—'}</td>
                    <td className="cell-mono">{client.cnpj ?? '—'}</td>
                    <td className="cell-sub">{client.billingEmail ?? '—'}</td>
                    <td>
                      <Badge def={badgeFor(ENTITY_STATUS, client.status)} />
                    </td>
                    <td className="num">{fmtInt(client.integrationsCount)}</td>
                    <td className="cell-mono">{fmtDateTime(client.createdAt)}</td>
                    <td className="cell-mono">{fmtDateTime(client.updatedAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button className="icon-act" title="Editar" onClick={() => setEditing(client)}>
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
        {pager}
      </div>

      {editing ? (
        <ClientModal
          client={editing === 'new' ? null : editing}
          integrations={integrations}
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

function ClientModal({
  client,
  integrations,
  onClose,
  onSaved,
}: {
  client: ClientView | null;
  integrations: Integration[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(
    client
      ? {
          name: client.name,
          legalName: client.legalName ?? '',
          cnpj: client.cnpj ?? '',
          billingEmail: client.billingEmail ?? '',
          status: client.status,
        }
      : emptyDraft(),
  );
  // Integrações marcadas como pertencentes a este cliente.
  const [assigned, setAssigned] = useState<string[]>(
    client ? integrations.filter((i) => i.clientId === client.id).map((i) => i.id) : [],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const toggleIntegration = (id: string) =>
    setAssigned((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await apiRequest<{ id: string }>(client ? `/clients/${client.id}` : '/clients', {
        method: client ? 'PATCH' : 'POST',
        body: JSON.stringify(draft),
      });
      const clientId = saved.id;
      // Reconcilia as integrações: atribui as marcadas, desvincula as que deixaram de estar.
      await Promise.all(
        integrations.map((integration) => {
          const wasMine = integration.clientId === clientId;
          const nowMine = assigned.includes(integration.id);
          if (wasMine === nowMine) return Promise.resolve();
          return apiRequest(`/integrations/${integration.id}/client`, {
            method: 'PATCH',
            body: JSON.stringify({ clientId: nowMine ? clientId : null }),
          });
        }),
      );
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao salvar cliente.');
      setSaving(false);
    }
  };

  return (
    <Modal
      title={client ? 'Editar cliente' : 'Novo cliente'}
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
          <label>Razão social</label>
          <input
            className="input"
            value={draft.legalName}
            onChange={(e) => set({ legalName: e.target.value })}
          />
        </div>
        <div className="field">
          <label>CNPJ</label>
          <input className="input" value={draft.cnpj} onChange={(e) => set({ cnpj: e.target.value })} />
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
        <div className="field col-2">
          <label>E-mail de cobrança</label>
          <input
            className="input"
            type="email"
            value={draft.billingEmail}
            onChange={(e) => set({ billingEmail: e.target.value })}
          />
        </div>

        <div className="field col-2">
          <label>Integrações do cliente</label>
          {integrations.length === 0 ? (
            <span className="cell-sub">Nenhuma integração cadastrada.</span>
          ) : (
            <div className="stack" style={{ gap: 4 }}>
              {integrations.map((integration) => {
                const checked = assigned.includes(integration.id);
                const ownedByOther = !checked && integration.clientId && integration.clientId !== (client?.id ?? '');
                return (
                  <label key={integration.id} className="check-row" style={{ padding: '6px 8px' }}>
                    <span className={`cbox${checked ? ' on' : ''}`} />
                    <input
                      type="checkbox"
                      style={{ display: 'none' }}
                      checked={checked}
                      onChange={() => toggleIntegration(integration.id)}
                    />
                    <span>{integration.name}</span>
                    {ownedByOther ? (
                      <span className="badge neutral" style={{ marginLeft: 'auto' }}>
                        vinculada a outro cliente
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          )}
          <span className="hint">
            Marque as integrações que este cliente pode usar. Ele também pode conectar as próprias na
            tela de Integrações.
          </span>
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
