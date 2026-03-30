'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../../components/app-shell';
import { SectionCard } from '../../components/section-card';
import { apiRequest } from '../../lib/api';

interface Integration {
  id: string;
  name: string;
}

interface ListItem {
  id: string;
  name: string;
  eligibleMembers: number;
}

interface Template {
  id: string;
  name: string;
  hasFlowButton: boolean;
  variableDescriptors: Array<{ componentType: string; placeholderIndex: number; label: string }>;
}

interface Campaign {
  id: string;
  name: string;
  status: string;
  mode: string;
  sendRateMps: number;
  summary: {
    total: number;
    pending: number;
    accepted: number;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    skipped: number;
  };
}

type MappingState = Record<
  string,
  { type: 'static' | 'contact_name' | 'contact_phone' | 'contact_email' | 'contact_attribute'; value?: string }
>;

export default function CampaignsPage() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [lists, setLists] = useState<ListItem[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [mapping, setMapping] = useState<MappingState>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: 'Pesquisa anual 2026',
    integrationId: '',
    listId: '',
    mode: 'template' as 'template' | 'template_flow',
    sendRateMps: '20',
  });

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedTemplateId) ?? null,
    [selectedTemplateId, templates],
  );

  const load = async () => {
    const [integrationsPayload, listsPayload, templatesPayload, campaignsPayload] =
      await Promise.all([
        apiRequest<Integration[]>('/integrations'),
        apiRequest<ListItem[]>('/lists'),
        apiRequest<Template[]>('/library/templates'),
        apiRequest<Campaign[]>('/campaigns'),
      ]);

    setIntegrations(integrationsPayload);
    setLists(listsPayload);
    setTemplates(templatesPayload);
    setCampaigns(campaignsPayload);

    if (!form.integrationId && integrationsPayload[0]) {
      setForm((current) => ({ ...current, integrationId: integrationsPayload[0].id }));
    }
    if (!form.listId && listsPayload[0]) {
      setForm((current) => ({ ...current, listId: listsPayload[0].id }));
    }
    if (!selectedTemplateId && templatesPayload[0]) {
      setSelectedTemplateId(templatesPayload[0].id);
      setForm((current) => ({
        ...current,
        mode: templatesPayload[0].hasFlowButton ? 'template_flow' : 'template',
      }));
    }
  };

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : 'Falha ao carregar'));
  }, []);

  useEffect(() => {
    if (!selectedTemplate) {
      return;
    }

    const nextMapping: MappingState = {};
    for (const variable of selectedTemplate.variableDescriptors) {
      const key = `${variable.componentType}:${variable.placeholderIndex}`;
      nextMapping[key] = mapping[key] ?? { type: 'contact_name' };
    }
    setMapping(nextMapping);
    setForm((current) => ({
      ...current,
      mode: selectedTemplate.hasFlowButton ? 'template_flow' : 'template',
    }));
  }, [selectedTemplate]);

  const createCampaign = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setMessage(null);

    const parameterMapping = Object.fromEntries(
      Object.entries(mapping).map(([key, value]) => {
        if (value.type === 'static') {
          return [key, { type: 'static', value: value.value ?? '' }];
        }
        if (value.type === 'contact_attribute') {
          return [key, { type: 'contact_attribute', key: value.value ?? '' }];
        }
        return [key, { type: value.type }];
      }),
    );

    try {
      const created = await apiRequest<{ id: string }>('/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          integrationId: form.integrationId,
          listId: form.listId,
          mode: form.mode,
          templateCacheId: selectedTemplateId,
          sendRateMps: Number(form.sendRateMps),
          parameterMapping,
        }),
      });

      await apiRequest(`/campaigns/${created.id}/start`, { method: 'POST' });
      setMessage('Campanha criada e enfileirada.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao criar campanha');
    }
  };

  const transition = async (campaignId: string, action: 'pause' | 'resume' | 'retry-failed') => {
    try {
      await apiRequest(`/campaigns/${campaignId}/${action}`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao atualizar campanha');
    }
  };

  return (
    <AppShell title="Campanhas">
      {error ? <div className="notice error">{error}</div> : null}
      {message ? <div className="notice">{message}</div> : null}

      <div className="grid two">
        <SectionCard title="Nova campanha" description="Disparo guiado sem editar payload manual.">
          <form className="stack" onSubmit={createCampaign}>
            <div className="field">
              <label>Nome</label>
              <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            </div>

            <div className="grid two">
              <div className="field">
                <label>Integração</label>
                <select
                  value={form.integrationId}
                  onChange={(event) => setForm({ ...form, integrationId: event.target.value })}
                >
                  {integrations.map((integration) => (
                    <option key={integration.id} value={integration.id}>
                      {integration.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label>Lista</label>
                <select value={form.listId} onChange={(event) => setForm({ ...form, listId: event.target.value })}>
                  {lists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.name} ({list.eligibleMembers} elegíveis)
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid two">
              <div className="field">
                <label>Template</label>
                <select
                  value={selectedTemplateId}
                  onChange={(event) => setSelectedTemplateId(event.target.value)}
                >
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name} {template.hasFlowButton ? '(FLOW)' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Rate (mps)</label>
                <input
                  type="number"
                  min={1}
                  max={80}
                  value={form.sendRateMps}
                  onChange={(event) => setForm({ ...form, sendRateMps: event.target.value })}
                />
              </div>
            </div>

            {selectedTemplate?.variableDescriptors.length ? (
              <div className="stack">
                <strong>Mapeamento de variáveis</strong>
                {selectedTemplate.variableDescriptors.map((variable) => {
                  const key = `${variable.componentType}:${variable.placeholderIndex}`;
                  const current = mapping[key] ?? { type: 'contact_name' as const };
                  return (
                    <div key={key} className="grid two">
                      <div className="field">
                        <label>{variable.label}</label>
                        <select
                          value={current.type}
                          onChange={(event) =>
                            setMapping((previous) => ({
                              ...previous,
                              [key]: {
                                type: event.target.value as MappingState[string]['type'],
                                value: '',
                              },
                            }))
                          }
                        >
                          <option value="contact_name">Nome do contato</option>
                          <option value="contact_phone">Telefone do contato</option>
                          <option value="contact_email">E-mail do contato</option>
                          <option value="contact_attribute">Atributo do contato</option>
                          <option value="static">Valor fixo</option>
                        </select>
                      </div>
                      {(current.type === 'static' || current.type === 'contact_attribute') ? (
                        <div className="field">
                          <label>{current.type === 'static' ? 'Valor' : 'Chave do atributo'}</label>
                          <input
                            value={current.value ?? ''}
                            onChange={(event) =>
                              setMapping((previous) => ({
                                ...previous,
                                [key]: { ...current, value: event.target.value },
                              }))
                            }
                          />
                        </div>
                      ) : (
                        <div className="notice">
                          A variável será resolvida automaticamente em runtime.
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="notice">Esse template não exige placeholders.</div>
            )}

            <button className="primary-button" type="submit">
              Criar e iniciar campanha
            </button>
          </form>
        </SectionCard>

        <SectionCard title="Campanhas existentes" description="Monitoramento e ações rápidas do piloto.">
          <div className="stack">
            {campaigns.length ? (
              campaigns.map((campaign) => (
                <div key={campaign.id} className="card" style={{ padding: 16 }}>
                  <div className="stack">
                    <div>
                      <strong>{campaign.name}</strong>
                      <div className="muted">
                        {campaign.mode} / {campaign.status} / {campaign.sendRateMps} mps
                      </div>
                    </div>
                    <div className="muted">
                      total {campaign.summary.total} | accepted {campaign.summary.accepted} | sent {campaign.summary.sent} | delivered {campaign.summary.delivered} | read {campaign.summary.read} | failed {campaign.summary.failed} | skipped {campaign.summary.skipped}
                    </div>
                    <div className="form-actions">
                      <button className="ghost-button" onClick={() => void transition(campaign.id, 'pause')}>
                        Pausar
                      </button>
                      <button className="ghost-button" onClick={() => void transition(campaign.id, 'resume')}>
                        Retomar
                      </button>
                      <button className="ghost-button" onClick={() => void transition(campaign.id, 'retry-failed')}>
                        Reprocessar falhas
                      </button>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="muted">Nenhuma campanha criada.</div>
            )}
          </div>
        </SectionCard>
      </div>
    </AppShell>
  );
}
