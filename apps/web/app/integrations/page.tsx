'use client';

import { FormEvent, useEffect, useState } from 'react';
import { AppShell } from '../../components/app-shell';
import { SectionCard } from '../../components/section-card';
import { apiRequest } from '../../lib/api';

interface Integration {
  id: string;
  name: string;
  graphApiBase: string;
  graphApiVersion: string;
  wabaId: string;
  phoneNumberId: string;
  webhookCallbackUrl?: string | null;
  lastSyncAt?: string | null;
  lastHealthcheckAt?: string | null;
}

const emptyForm = {
  name: '',
  graphApiBase: 'https://graph.facebook.com',
  graphApiVersion: 'v23.0',
  wabaId: '',
  phoneNumberId: '',
  accessToken: '',
  verifyToken: '',
  appSecret: '',
  webhookCallbackUrl: '',
};

export default function IntegrationsPage() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const payload = await apiRequest<Integration[]>('/integrations');
    setIntegrations(payload);
  };

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : 'Falha ao carregar'));
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setMessage(null);

    try {
      await apiRequest('/integrations', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setMessage('Integração salva.');
      setForm(emptyForm);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao salvar');
    }
  };

  const runAction = async (integrationId: string, path: string, success: string) => {
    setError(null);
    setMessage(null);
    try {
      await apiRequest(`/integrations/${integrationId}/${path}`, { method: 'POST' });
      setMessage(success);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha na ação');
    }
  };

  return (
    <AppShell title="Integrações Meta">
      {error ? <div className="notice error">{error}</div> : null}
      {message ? <div className="notice">{message}</div> : null}

      <div className="grid two">
        <SectionCard
          title="Salvar integração"
          description="Conexão direta com a WABA e o número emissor."
        >
          <form className="stack" onSubmit={submit}>
            <div className="field">
              <label>Nome</label>
              <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </div>
            <div className="grid two">
              <div className="field">
                <label>Graph API Base</label>
                <input
                  value={form.graphApiBase}
                  onChange={(event) => setForm({ ...form, graphApiBase: event.target.value })}
                />
              </div>
              <div className="field">
                <label>Versão</label>
                <input
                  value={form.graphApiVersion}
                  onChange={(event) => setForm({ ...form, graphApiVersion: event.target.value })}
                />
              </div>
            </div>
            <div className="grid two">
              <div className="field">
                <label>WABA ID</label>
                <input value={form.wabaId} onChange={(event) => setForm({ ...form, wabaId: event.target.value })} />
              </div>
              <div className="field">
                <label>Phone Number ID</label>
                <input
                  value={form.phoneNumberId}
                  onChange={(event) => setForm({ ...form, phoneNumberId: event.target.value })}
                />
              </div>
            </div>
            <div className="field">
              <label>Access Token</label>
              <textarea
                rows={3}
                value={form.accessToken}
                onChange={(event) => setForm({ ...form, accessToken: event.target.value })}
              />
            </div>
            <div className="grid two">
              <div className="field">
                <label>Verify Token</label>
                <input
                  value={form.verifyToken}
                  onChange={(event) => setForm({ ...form, verifyToken: event.target.value })}
                />
              </div>
              <div className="field">
                <label>App Secret</label>
                <input
                  value={form.appSecret}
                  onChange={(event) => setForm({ ...form, appSecret: event.target.value })}
                />
              </div>
            </div>
            <div className="field">
              <label>Webhook callback URL</label>
              <input
                value={form.webhookCallbackUrl}
                onChange={(event) => setForm({ ...form, webhookCallbackUrl: event.target.value })}
              />
            </div>
            <button className="primary-button" type="submit">
              Salvar integração
            </button>
          </form>
        </SectionCard>

        <SectionCard title="Integrações cadastradas" description="Teste de conexão e sincronização oficial da Meta.">
          <div className="stack">
            {integrations.length ? (
              integrations.map((integration) => (
                <div key={integration.id} className="card" style={{ padding: 16 }}>
                  <div className="stack">
                    <div>
                      <strong>{integration.name}</strong>
                      <div className="muted">
                        WABA {integration.wabaId} / número {integration.phoneNumberId}
                      </div>
                    </div>
                    <div className="form-actions">
                      <button
                        className="ghost-button"
                        onClick={() => void runAction(integration.id, 'test', 'Conexão validada.')}
                      >
                        Testar conexão
                      </button>
                      <button
                        className="ghost-button"
                        onClick={() =>
                          void runAction(
                            integration.id,
                            'sync/templates',
                            'Templates sincronizados.',
                          )
                        }
                      >
                        Sincronizar templates
                      </button>
                      <button
                        className="ghost-button"
                        onClick={() =>
                          void runAction(integration.id, 'sync/flows', 'Flows sincronizados.')
                        }
                      >
                        Sincronizar flows
                      </button>
                    </div>
                    <div className="muted">
                      Último sync: {integration.lastSyncAt ? new Date(integration.lastSyncAt).toLocaleString('pt-BR') : 'nunca'}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="muted">Nenhuma integração salva.</div>
            )}
          </div>
        </SectionCard>
      </div>
    </AppShell>
  );
}
