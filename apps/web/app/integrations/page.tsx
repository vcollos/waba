'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell, useShell } from '../../components/app-shell';
import {
  Badge,
  EmptyState,
  ErrorBanner,
  Forbidden,
  Modal,
  SkeletonRows,
  ToastHost,
  usePagedRows,
  useToasts,
} from '../../components/ui';
import { apiRequest } from '../../lib/api';
import { INTEGRATION_STATUS, badgeFor } from '../../lib/badges';
import { fmtDateTime } from '../../lib/format';
import { ClientRecord, isCollosRole } from '../../lib/session';

interface Integration {
  id: string;
  name: string;
  graphApiBase: string;
  graphApiVersion: string;
  wabaId: string;
  phoneNumberId: string;
  clientId: string | null;
  webhookCallbackUrl?: string | null;
  status: 'active' | 'inactive';
  lastSyncAt?: string | null;
  lastHealthcheckAt?: string | null;
}

export default function IntegrationsPage() {
  return (
    <AppShell title="Integrações">
      <IntegrationsContent />
    </AppShell>
  );
}

function IntegrationsContent() {
  const { session, clients } = useShell();
  const { toasts, push } = useToasts();
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Integration | 'new' | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    void apiRequest<Integration[]>('/integrations')
      .then((data) => {
        setIntegrations(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar integrações.');
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (isCollosRole(session.role)) load();
  }, [load, session.role]);

  const { pageRows, pager } = usePagedRows(integrations, 'integração(ões)');

  const runAction = async (id: string, path: string, success: string) => {
    setPending(`${id}:${path}`);
    try {
      await apiRequest(`/integrations/${id}/${path}`, { method: 'POST' });
      push('success', success);
      load();
    } catch (err) {
      push('danger', err instanceof Error ? err.message : 'Falha na ação.');
    } finally {
      setPending(null);
    }
  };

  const clientName = (clientId: string | null): string =>
    clientId ? clients.find((c) => c.id === clientId)?.name ?? '—' : 'Pool Collos';

  if (!isCollosRole(session.role)) {
    return <Forbidden />;
  }

  return (
    <>
      <div className="op-head">
        <div className="op-head-titles">
          <h1 className="op-title">Integrações</h1>
          <p className="op-sub">Conexões WABA com a Meta — apenas endpoints oficiais.</p>
        </div>
        <div className="op-actions">
          <button className="btn primary md" onClick={() => setEditing('new')}>
            Nova integração
          </button>
        </div>
      </div>

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}

      <div className="tbl-wrap">
        <table className="tbl dense">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Cliente</th>
              <th>WABA ID</th>
              <th>Phone Number ID</th>
              <th>Graph API</th>
              <th>Status</th>
              <th>Último sync</th>
              <th>Último teste</th>
              <th></th>
            </tr>
          </thead>
          {loading ? (
            <SkeletonRows rows={5} cols={9} />
          ) : (
            <tbody>
              {integrations.length === 0 ? (
                <tr>
                  <td colSpan={9}>
                    <EmptyState title="Nenhuma integração cadastrada" />
                  </td>
                </tr>
              ) : (
                pageRows.map((integration) => (
                  <tr key={integration.id}>
                    <td className="cell-strong">{integration.name}</td>
                    <td className="cell-sub">{clientName(integration.clientId)}</td>
                    <td className="cell-mono">{integration.wabaId}</td>
                    <td className="cell-mono">{integration.phoneNumberId}</td>
                    <td className="cell-mono">{integration.graphApiVersion}</td>
                    <td>
                      <Badge def={badgeFor(INTEGRATION_STATUS, integration.status)} />
                    </td>
                    <td className="cell-mono">{fmtDateTime(integration.lastSyncAt)}</td>
                    <td className="cell-mono">{fmtDateTime(integration.lastHealthcheckAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="icon-act"
                          title="Testar conexão"
                          disabled={pending !== null}
                          onClick={() => runAction(integration.id, 'test', 'Conexão validada.')}
                        >
                          <PlugIcon />
                        </button>
                        <button
                          className="icon-act"
                          title="Sincronizar templates"
                          disabled={pending !== null}
                          onClick={() =>
                            runAction(integration.id, 'sync/templates', 'Templates sincronizados.')
                          }
                        >
                          <TemplateIcon />
                        </button>
                        <button
                          className="icon-act"
                          title="Sincronizar flows"
                          disabled={pending !== null}
                          onClick={() => runAction(integration.id, 'sync/flows', 'Flows sincronizados.')}
                        >
                          <FlowIcon />
                        </button>
                        <button
                          className="icon-act"
                          title="Editar"
                          onClick={() => setEditing(integration)}
                        >
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
        <IntegrationModal
          integration={editing === 'new' ? null : editing}
          clients={clients}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            push('success', 'Integração salva.');
            load();
          }}
        />
      ) : null}

      <ToastHost toasts={toasts} />
    </>
  );
}

interface Draft {
  name: string;
  graphApiBase: string;
  graphApiVersion: string;
  wabaId: string;
  phoneNumberId: string;
  webhookCallbackUrl: string;
  clientId: string;
  status: 'active' | 'inactive';
}

function IntegrationModal({
  integration,
  clients,
  onClose,
  onSaved,
}: {
  integration: Integration | null;
  clients: ClientRecord[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Draft>({
    name: integration?.name ?? '',
    graphApiBase: integration?.graphApiBase ?? 'https://graph.facebook.com',
    graphApiVersion: integration?.graphApiVersion ?? 'v23.0',
    wabaId: integration?.wabaId ?? '',
    phoneNumberId: integration?.phoneNumberId ?? '',
    webhookCallbackUrl: integration?.webhookCallbackUrl ?? '',
    clientId: integration?.clientId ?? '',
    status: integration?.status ?? 'active',
  });
  // Segredos nunca chegam do servidor; ficam mascarados até o operador optar por atualizar.
  const [secrets, setSecrets] = useState({ accessToken: '', verifyToken: '', appSecret: '' });
  const [editSecret, setEditSecret] = useState<Record<string, boolean>>(
    integration ? {} : { accessToken: true, verifyToken: true },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        ...draft,
        clientId: draft.clientId || null,
      };
      if (integration) payload.id = integration.id;
      // Só envia segredos que o operador escolheu atualizar.
      if (editSecret.accessToken && secrets.accessToken) payload.accessToken = secrets.accessToken;
      if (editSecret.verifyToken && secrets.verifyToken) payload.verifyToken = secrets.verifyToken;
      if (editSecret.appSecret && secrets.appSecret) payload.appSecret = secrets.appSecret;
      // Na criação, access/verify token são exigidos pelo backend; não enviar string vazia.
      if (!integration) {
        payload.accessToken = secrets.accessToken;
        payload.verifyToken = secrets.verifyToken;
        if (secrets.appSecret) payload.appSecret = secrets.appSecret;
      }
      await apiRequest('/integrations', { method: 'POST', body: JSON.stringify(payload) });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao salvar integração.');
      setSaving(false);
    }
  };

  return (
    <Modal
      title={integration ? 'Editar integração' : 'Nova integração'}
      desc="Use apenas credenciais oficiais da Meta. Os segredos nunca são exibidos."
      width="wide"
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
        <div className="field">
          <label>Graph API Base</label>
          <input
            className="input"
            value={draft.graphApiBase}
            onChange={(e) => set({ graphApiBase: e.target.value })}
          />
        </div>
        <div className="field">
          <label>Graph API Version</label>
          <input
            className="input"
            value={draft.graphApiVersion}
            onChange={(e) => set({ graphApiVersion: e.target.value })}
          />
        </div>
        <div className="field">
          <label>
            WABA ID <span className="req">*</span>
          </label>
          <input className="input" value={draft.wabaId} onChange={(e) => set({ wabaId: e.target.value })} />
        </div>
        <div className="field">
          <label>
            Phone Number ID <span className="req">*</span>
          </label>
          <input
            className="input"
            value={draft.phoneNumberId}
            onChange={(e) => set({ phoneNumberId: e.target.value })}
          />
        </div>
        <div className="field">
          <label>Cliente</label>
          <select
            className="input"
            value={draft.clientId}
            onChange={(e) => set({ clientId: e.target.value })}
          >
            <option value="">Pool Collos (sem tenant)</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Status</label>
          <select
            className="input"
            value={draft.status}
            onChange={(e) => set({ status: e.target.value as Draft['status'] })}
          >
            <option value="active">Ativa</option>
            <option value="inactive">Inativa</option>
          </select>
        </div>

        <SecretField
          label="Access Token"
          required={!integration}
          editing={!!editSecret.accessToken}
          value={secrets.accessToken}
          onEdit={() => setEditSecret((c) => ({ ...c, accessToken: true }))}
          onChange={(value) => setSecrets((c) => ({ ...c, accessToken: value }))}
        />
        <SecretField
          label="Verify Token"
          required={!integration}
          editing={!!editSecret.verifyToken}
          value={secrets.verifyToken}
          onEdit={() => setEditSecret((c) => ({ ...c, verifyToken: true }))}
          onChange={(value) => setSecrets((c) => ({ ...c, verifyToken: value }))}
        />
        <SecretField
          label="App Secret"
          editing={!!editSecret.appSecret}
          value={secrets.appSecret}
          onEdit={() => setEditSecret((c) => ({ ...c, appSecret: true }))}
          onChange={(value) => setSecrets((c) => ({ ...c, appSecret: value }))}
        />

        <div className="field col-2">
          <label>Webhook callback URL</label>
          <input
            className="input"
            value={draft.webhookCallbackUrl}
            onChange={(e) => set({ webhookCallbackUrl: e.target.value })}
          />
        </div>
      </div>
    </Modal>
  );
}

function SecretField({
  label,
  required,
  editing,
  value,
  onEdit,
  onChange,
}: {
  label: string;
  required?: boolean;
  editing: boolean;
  value: string;
  onEdit: () => void;
  onChange: (value: string) => void;
}) {
  return (
    <div className="field">
      <label>
        {label} {required ? <span className="req">*</span> : null}
      </label>
      {editing ? (
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <div className="secret-row">
          <div className="secret-mask">••••••••••••</div>
          <button type="button" className="btn secondary sm" onClick={onEdit}>
            Atualizar
          </button>
        </div>
      )}
    </div>
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
function PlugIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-10 0Z" />
      <path d="M12 16v6" />
    </svg>
  );
}
function TemplateIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M9 21V9" />
    </svg>
  );
}
function FlowIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <path d="M10 6.5h5a2 2 0 0 1 2 2V14" />
    </svg>
  );
}
