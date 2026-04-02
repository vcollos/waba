'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../../components/app-shell';
import { SectionCard } from '../../components/section-card';
import { apiRequest } from '../../lib/api';

const MESSAGE_PAGE_SIZE = 100;
const ACTIVE_CAMPAIGN_STATUSES = new Set(['queued', 'sending']);
const ALL_CATEGORIES_VALUE = '__all_categories__';

interface Integration {
  id: string;
  name: string;
}

interface ListCategoryOption {
  value: string;
  label: string;
  eligibleMembers: number;
  totalMembers: number;
}

interface ListItem {
  id: string;
  name: string;
  eligibleMembers: number;
  totalMembers: number;
  categories?: ListCategoryOption[];
}

interface Template {
  id: string;
  name: string;
  hasFlowButton: boolean;
  variableDescriptors: Array<{ componentType: string; placeholderIndex: number; label: string }>;
}

interface CampaignAudience {
  mode: 'all' | 'fixed_count' | 'percentage';
  fixedCount?: number | null;
  percentage?: number | null;
  category?: string | null;
  orderMode: 'field' | 'random';
  orderField?:
    | 'clientName'
    | 'firstName'
    | 'lastName'
    | 'name'
    | 'category'
    | 'phoneE164'
    | 'importedAt'
    | 'createdAt'
    | null;
  orderDirection: 'asc' | 'desc';
  resendPolicy: 'all' | 'not_delivered' | 'not_read';
  uniqueWhatsAppOnly?: boolean;
}

interface CampaignAudienceSnapshot {
  listMembersTotal: number;
  eligibleCount: number;
  afterCategoryFilterCount?: number;
  afterResendFilterCount: number;
  afterUniqueWhatsAppFilterCount?: number;
  excludedByCategory?: number;
  excludedByUniqueWhatsApp?: number;
  excludedByResendPolicy: number;
  selectedCount: number;
}

interface CampaignSummary {
  total: number;
  pending: number;
  accepted: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
}

interface Campaign {
  id: string;
  name: string;
  status: string;
  mode: string;
  sendRateMps: number;
  audience: CampaignAudience;
  audienceSnapshot: CampaignAudienceSnapshot;
  summary: CampaignSummary;
}

interface CampaignMessage {
  id: string;
  phoneE164: string;
  status: string;
  attemptCount: number;
  providerMessageId?: string | null;
  providerErrorTitle?: string | null;
  providerErrorCode?: string | null;
  providerErrorMessage?: string | null;
  skipReason?: string | null;
  sentAt?: string | null;
  deliveredAt?: string | null;
  readAt?: string | null;
  failedAt?: string | null;
  updatedAt: string;
  contactName?: string | null;
  contactFirstName?: string | null;
  contactLastName?: string | null;
  contactClientName?: string | null;
  contactCategory?: string | null;
}

interface CampaignDetail extends Campaign {
  template?: { id: string; name: string } | null;
  flow?: { id: string; name: string } | null;
  list?: { id: string; name: string } | null;
  messagesTotal: number;
  messagesLimit: number;
  messagesOffset: number;
  messagesHasMore: boolean;
  messages: CampaignMessage[];
}

type MappingState = Record<
  string,
  { type: 'static' | 'contact_name' | 'contact_phone' | 'contact_email' | 'contact_attribute'; value?: string }
>;

const orderFieldOptions: Array<{ value: NonNullable<CampaignAudience['orderField']>; label: string }> = [
  { value: 'importedAt', label: 'Data de importação' },
  { value: 'createdAt', label: 'Data de cadastro' },
  { value: 'clientName', label: 'Cliente' },
  { value: 'firstName', label: 'Nome' },
  { value: 'lastName', label: 'Sobrenome' },
  { value: 'name', label: 'Nome completo' },
  { value: 'category', label: 'Categoria' },
  { value: 'phoneE164', label: 'Telefone' },
];

export default function CampaignsPage() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [lists, setLists] = useState<ListItem[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [selectedCampaignId, setSelectedCampaignId] = useState('');
  const [selectedCampaign, setSelectedCampaign] = useState<CampaignDetail | null>(null);
  const [mapping, setMapping] = useState<MappingState>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [creatingCampaign, setCreatingCampaign] = useState(false);
  const [creatingCampaignName, setCreatingCampaignName] = useState<string | null>(null);
  const [messageOffset, setMessageOffset] = useState(0);
  const [form, setForm] = useState({
    name: 'Pesquisa anual 2026',
    integrationId: '',
    listId: '',
    mode: 'template' as 'template' | 'template_flow',
    sendRateMps: '20',
    audienceMode: 'all' as CampaignAudience['mode'],
    audienceValue: '10',
    audienceCategory: ALL_CATEGORIES_VALUE,
    orderMode: 'field' as CampaignAudience['orderMode'],
    orderField: 'importedAt' as NonNullable<CampaignAudience['orderField']>,
    orderDirection: 'asc' as CampaignAudience['orderDirection'],
    resendPolicy: 'all' as CampaignAudience['resendPolicy'],
    uniqueWhatsAppOnly: false,
  });

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedTemplateId) ?? null,
    [selectedTemplateId, templates],
  );
  const selectedList = useMemo(
    () => lists.find((list) => list.id === form.listId) ?? null,
    [form.listId, lists],
  );
  const selectedCategory = useMemo(
    () =>
      form.audienceCategory === ALL_CATEGORIES_VALUE
        ? null
        : selectedList?.categories?.find((category) => category.value === form.audienceCategory) ?? null,
    [form.audienceCategory, selectedList],
  );
  const hasActiveCampaign = useMemo(
    () => campaigns.some((campaign) => ACTIVE_CAMPAIGN_STATUSES.has(campaign.status)),
    [campaigns],
  );
  const estimatedSelectionCount = useMemo(() => {
    if (!selectedList) {
      return 0;
    }

    const base = selectedCategory?.eligibleMembers ?? selectedList.eligibleMembers;
    if (form.audienceMode === 'fixed_count') {
      return Math.min(base, Math.max(0, Number(form.audienceValue || '0')));
    }

    if (form.audienceMode === 'percentage') {
      const percentage = Math.max(1, Math.min(100, Number(form.audienceValue || '100')));
      return base ? Math.max(1, Math.ceil((base * percentage) / 100)) : 0;
    }

    return base;
  }, [form.audienceMode, form.audienceValue, selectedCategory, selectedList]);

  const loadCampaignDetail = async (
    campaignId: string,
    offset = 0,
    options?: { background?: boolean },
  ) => {
    if (!options?.background) {
      setLoadingDetail(true);
    }
    try {
      const detail = await apiRequest<CampaignDetail>(
        `/campaigns/${campaignId}?limit=${MESSAGE_PAGE_SIZE}&offset=${offset}`,
      );
      setSelectedCampaign(detail);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar detalhes da campanha');
    } finally {
      if (!options?.background) {
        setLoadingDetail(false);
      }
    }
  };

  const loadCampaignsOnly = async () => {
    const campaignsPayload = await apiRequest<Campaign[]>('/campaigns');
    setCampaigns(campaignsPayload);
    return campaignsPayload;
  };

  const load = async (preferredCampaignId?: string, preferredOffset = 0) => {
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

    setForm((current) => ({
      ...current,
      integrationId: current.integrationId || integrationsPayload[0]?.id || '',
      listId: current.listId || listsPayload[0]?.id || '',
    }));

    if (!selectedTemplateId && templatesPayload[0]) {
      setSelectedTemplateId(templatesPayload[0].id);
      setForm((current) => ({
        ...current,
        mode: templatesPayload[0].hasFlowButton ? 'template_flow' : 'template',
      }));
    }

    const nextCampaignId = preferredCampaignId ?? selectedCampaignId ?? campaignsPayload[0]?.id ?? '';
    setSelectedCampaignId(nextCampaignId);
    if (nextCampaignId) {
      await loadCampaignDetail(nextCampaignId, preferredOffset);
    } else {
      setSelectedCampaign(null);
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

  useEffect(() => {
    if (form.audienceCategory === ALL_CATEGORIES_VALUE) {
      return;
    }

    const categoryStillExists = selectedList?.categories?.some((category) => category.value === form.audienceCategory);
    if (categoryStillExists) {
      return;
    }

    setForm((current) => ({
      ...current,
      audienceCategory: ALL_CATEGORIES_VALUE,
    }));
  }, [form.audienceCategory, selectedList]);

  useEffect(() => {
    if (!selectedCampaignId) {
      return;
    }

    setMessageOffset(0);
    void loadCampaignDetail(selectedCampaignId, 0);
  }, [selectedCampaignId]);

  useEffect(() => {
    if (!selectedCampaignId) {
      return;
    }

    void loadCampaignDetail(selectedCampaignId, messageOffset, { background: loadingDetail });
  }, [messageOffset]);

  useEffect(() => {
    if (!hasActiveCampaign) {
      return;
    }

    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      void (async () => {
        try {
          const campaignsPayload = await loadCampaignsOnly();
          if (selectedCampaignId) {
            const selectedStillExists = campaignsPayload.some((campaign) => campaign.id === selectedCampaignId);
            if (selectedStillExists) {
              await loadCampaignDetail(selectedCampaignId, messageOffset, { background: true });
            }
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Falha ao atualizar campanhas');
        }
      })();
    }, 10000);

    return () => window.clearInterval(timer);
  }, [hasActiveCampaign, selectedCampaignId, messageOffset]);

  const createCampaign = async (event: FormEvent) => {
    event.preventDefault();
    if (creatingCampaign) {
      return;
    }

    setError(null);
    setMessage(null);
    setCreatingCampaign(true);
    setCreatingCampaignName(form.name.trim() || 'Nova campanha');

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

    const audience: Partial<CampaignAudience> = {
      mode: form.audienceMode,
      category: form.audienceCategory === ALL_CATEGORIES_VALUE ? null : form.audienceCategory,
      orderMode: form.orderMode,
      orderDirection: form.orderDirection,
      resendPolicy: form.resendPolicy,
      uniqueWhatsAppOnly: form.uniqueWhatsAppOnly,
      orderField: form.orderMode === 'field' ? form.orderField : null,
      fixedCount: form.audienceMode === 'fixed_count' ? Number(form.audienceValue) : null,
      percentage: form.audienceMode === 'percentage' ? Number(form.audienceValue) : null,
    };

    try {
      const campaign = await apiRequest<{ id: string }>('/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          integrationId: form.integrationId,
          listId: form.listId,
          mode: form.mode,
          templateCacheId: selectedTemplateId,
          sendRateMps: Number(form.sendRateMps),
          parameterMapping,
          audience,
        }),
      });

      setMessage('Campanha criada em rascunho. Revise os registros e clique em "Enviar" para confirmar.');
      await load(campaign.id, 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao criar campanha');
    } finally {
      setCreatingCampaign(false);
      setCreatingCampaignName(null);
    }
  };

  const confirmSendingAction = (): boolean =>
    typeof window === 'undefined' ? false : window.confirm('Confirma envio?');

  const sendCampaign = async (campaignId: string) => {
    if (!confirmSendingAction()) {
      return;
    }

    try {
      await apiRequest(`/campaigns/${campaignId}/start`, { method: 'POST' });
      setMessage('Campanha enviada para fila.');
      await load(campaignId, messageOffset);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao enviar campanha');
    }
  };

  const deleteDraftCampaign = async (campaignId: string) => {
    if (typeof window !== 'undefined' && !window.confirm('Excluir este rascunho?')) {
      return;
    }

    try {
      await apiRequest(`/campaigns/${campaignId}`, { method: 'DELETE' });
      setMessage('Rascunho excluído.');
      const nextSelectedCampaignId =
        selectedCampaignId === campaignId ? campaigns.find((campaign) => campaign.id !== campaignId)?.id : selectedCampaignId;
      await load(nextSelectedCampaignId, 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao excluir rascunho');
    }
  };

  const transition = async (campaignId: string, action: 'pause' | 'resume' | 'retry-failed') => {
    if (action !== 'pause' && !confirmSendingAction()) {
      return;
    }

    try {
      await apiRequest(`/campaigns/${campaignId}/${action}`, { method: 'POST' });
      setMessage(
        action === 'pause'
          ? 'Campanha pausada.'
          : action === 'resume'
            ? 'Envio retomado.'
            : 'Reprocessamento confirmado.',
      );
      await load(campaignId, messageOffset);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao atualizar campanha');
    }
  };

  return (
    <AppShell title="Campanhas">
      {error ? <div className="notice error">{error}</div> : null}
      {message ? <div className="notice">{message}</div> : null}

      <div className="grid two">
        <SectionCard title="Nova campanha" description="Cria em rascunho, prepara os registros e só envia com confirmação.">
          {creatingCampaign ? (
            <div className="notice campaign-progress" role="status" aria-live="polite">
              <div className="campaign-progress-head">
                <strong>Criando rascunho...</strong>
                <span className="muted">{creatingCampaignName}</span>
              </div>
              <div className="campaign-progress-track" aria-hidden="true">
                <div className="campaign-progress-bar" />
              </div>
              <div className="muted">
                Materializando a seleção e preparando os registros. Aguarde sem clicar novamente.
              </div>
            </div>
          ) : null}
          <form className="stack" onSubmit={createCampaign}>
            <fieldset className="campaign-form-fieldset" disabled={creatingCampaign}>
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
                        {list.name} ({list.eligibleMembers} elegíveis / {list.totalMembers} total)
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid two">
                <div className="field">
                  <label>Template</label>
                  <select value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)}>
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

              <div className="card campaign-config-card">
                <div className="stack">
                  <div>
                    <strong>Segmentação do envio</strong>
                    <div className="muted">Defina amostragem, ordem e regra de reenvio antes de criar.</div>
                  </div>

                  <div className="grid two">
                    <div className="field">
                      <label>Modo de seleção</label>
                      <select
                        value={form.audienceMode}
                        onChange={(event) => setForm({ ...form, audienceMode: event.target.value as CampaignAudience['mode'] })}
                      >
                        <option value="all">Toda a lista elegível</option>
                        <option value="fixed_count">Quantidade fixa</option>
                        <option value="percentage">Percentual da lista</option>
                      </select>
                    </div>
                    <div className="field">
                      <label>{form.audienceMode === 'percentage' ? 'Percentual (%)' : 'Quantidade'}</label>
                      <input
                        type="number"
                        min={1}
                        max={form.audienceMode === 'percentage' ? 100 : Math.max(selectedCategory?.eligibleMembers ?? selectedList?.eligibleMembers ?? 1, 1)}
                        value={
                          form.audienceMode === 'all'
                            ? selectedCategory?.eligibleMembers ?? selectedList?.eligibleMembers ?? 0
                            : form.audienceValue
                        }
                        disabled={form.audienceMode === 'all'}
                        onChange={(event) => setForm({ ...form, audienceValue: event.target.value })}
                      />
                    </div>
                  </div>

                  <div className="field">
                    <label>Categoria da lista</label>
                    <select
                      value={form.audienceCategory}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          audienceCategory: event.target.value,
                        })
                      }
                    >
                      <option value={ALL_CATEGORIES_VALUE}>Todas as categorias elegíveis</option>
                      {(selectedList?.categories ?? []).map((category) => (
                        <option key={category.value} value={category.value}>
                          {category.label} ({category.eligibleMembers} elegíveis / {category.totalMembers} total)
                        </option>
                      ))}
                    </select>
                    <div className="muted">Aplica o filtro antes da regra de reenvio e do WhatsApp único.</div>
                  </div>

                  <div className="grid three">
                    <div className="field">
                      <label>Ordem</label>
                      <select
                        value={form.orderMode}
                        onChange={(event) =>
                          setForm({ ...form, orderMode: event.target.value as CampaignAudience['orderMode'] })
                        }
                      >
                        <option value="field">Por campo do cadastro</option>
                        <option value="random">Aleatória</option>
                      </select>
                    </div>
                    <div className="field">
                      <label>Campo</label>
                      <select
                        value={form.orderField}
                        disabled={form.orderMode !== 'field'}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            orderField: event.target.value as NonNullable<CampaignAudience['orderField']>,
                          })
                        }
                      >
                        {orderFieldOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label>Direção</label>
                      <select
                        value={form.orderDirection}
                        disabled={form.orderMode !== 'field'}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            orderDirection: event.target.value as CampaignAudience['orderDirection'],
                          })
                        }
                      >
                        <option value="asc">Crescente</option>
                        <option value="desc">Decrescente</option>
                      </select>
                    </div>
                  </div>

                  <div className="field">
                    <label>Regra de reenvio</label>
                    <select
                      value={form.resendPolicy}
                      onChange={(event) =>
                        setForm({ ...form, resendPolicy: event.target.value as CampaignAudience['resendPolicy'] })
                      }
                    >
                      <option value="all">Enviar para todos da seleção</option>
                      <option value="not_delivered">Enviar só para quem ainda não recebeu</option>
                      <option value="not_read">Enviar só para quem ainda não leu</option>
                    </select>
                  </div>

                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={form.uniqueWhatsAppOnly}
                      onChange={(event) =>
                        setForm({ ...form, uniqueWhatsAppOnly: event.target.checked })
                      }
                    />
                    <span>WhatsApp único: enviar somente 1 vez por número</span>
                  </label>

                  <div className="notice">
                    Projeção inicial com base nos elegíveis
                    {selectedCategory ? (
                      <>
                        {' '}da categoria <strong>{selectedCategory.label}</strong>
                      </>
                    ) : (
                      <> da lista</>
                    )}
                    : <strong>{estimatedSelectionCount}</strong> contato(s). O total final pode cair após aplicar regra
                    de reenvio e WhatsApp único.
                  </div>
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
                        {current.type === 'static' || current.type === 'contact_attribute' ? (
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
                          <div className="notice">A variável será resolvida automaticamente em runtime.</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="notice">Esse template não exige placeholders.</div>
              )}

              <button className="primary-button" type="submit">
                {creatingCampaign ? 'Criando rascunho...' : 'Criar campanha'}
              </button>
            </fieldset>
          </form>
        </SectionCard>

        <SectionCard title="Campanhas existentes" description="Rascunho, envio, retomada e revisão rápida da seleção.">
          <div className="stack">
            {campaigns.length ? (
              campaigns.map((campaign) => (
                <div
                  key={campaign.id}
                  className={`card campaign-item ${selectedCampaignId === campaign.id ? 'campaign-item-active' : ''}`}
                >
                  <div className="stack">
                    <div className="campaign-item-head">
                      <div>
                        <strong>{campaign.name}</strong>
                        <div className="muted">
                          {campaign.mode} / {campaign.status} / {campaign.sendRateMps} mps
                        </div>
                      </div>
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => setSelectedCampaignId(campaign.id)}
                      >
                        Ver registros
                      </button>
                    </div>

                    <div className="campaign-inline-stats">
                      <span className="tag">{campaign.summary.total} registros</span>
                      <span className="tag">{campaign.summary.pending} pendentes</span>
                      <span className="tag success">{campaign.summary.delivered} entregues</span>
                      <span className="tag success">{campaign.summary.read} lidas</span>
                      <span className="tag danger">{campaign.summary.failed} falhas</span>
                    </div>

                    <div className="muted">
                      lista {campaign.audienceSnapshot.listMembersTotal} | elegíveis{' '}
                      {campaign.audienceSnapshot.eligibleCount}
                      {campaign.audience.category ? (
                        <>
                          {' '}| categoria <strong>{campaign.audience.category}</strong> | após categoria{' '}
                          {campaign.audienceSnapshot.afterCategoryFilterCount ??
                            campaign.audienceSnapshot.eligibleCount}
                        </>
                      ) : null}
                      {' '}| após regra de reenvio {campaign.audienceSnapshot.afterResendFilterCount}
                      {campaign.audience.uniqueWhatsAppOnly ? (
                        <>
                          {' '}
                          | após WhatsApp único{' '}
                          {campaign.audienceSnapshot.afterUniqueWhatsAppFilterCount ??
                            campaign.audienceSnapshot.afterResendFilterCount}
                        </>
                      ) : (
                        <> | sem filtro de WhatsApp único</>
                      )}{' '}
                      | selecionados{' '}
                      {campaign.audienceSnapshot.selectedCount}
                    </div>

                    <div className="form-actions">
                      {campaign.status === 'draft' ? (
                        <button className="primary-button" type="button" onClick={() => void sendCampaign(campaign.id)}>
                          Enviar
                        </button>
                      ) : null}
                      {campaign.status === 'draft' ? (
                        <button
                          className="danger-button"
                          type="button"
                          onClick={() => void deleteDraftCampaign(campaign.id)}
                        >
                          Excluir rascunho
                        </button>
                      ) : null}
                      {['queued', 'sending'].includes(campaign.status) ? (
                        <button className="ghost-button" type="button" onClick={() => void transition(campaign.id, 'pause')}>
                          Pausar
                        </button>
                      ) : null}
                      {campaign.status === 'paused' ? (
                        <button className="ghost-button" type="button" onClick={() => void transition(campaign.id, 'resume')}>
                          Retomar
                        </button>
                      ) : null}
                      {campaign.summary.failed > 0 ? (
                        <button className="ghost-button" type="button" onClick={() => void transition(campaign.id, 'retry-failed')}>
                          Reprocessar falhas
                        </button>
                      ) : null}
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

      <SectionCard
        title="Registros de envio"
        description="Tabela operacional da campanha selecionada, útil para revisar amostra, ordem e resultado por contato."
      >
        <div className="form-actions">
          <div className="muted">
            {hasActiveCampaign
              ? 'Atualização automática a cada 5 segundos enquanto houver campanha em fila.'
              : 'Sem campanha ativa no momento.'}
          </div>
          {selectedCampaignId ? (
            <button
              className="ghost-button"
              type="button"
              onClick={() => void loadCampaignDetail(selectedCampaignId, messageOffset)}
            >
              Atualizar agora
            </button>
          ) : null}
        </div>
        {loadingDetail ? <div className="notice">Carregando detalhes da campanha...</div> : null}
        {!loadingDetail && !selectedCampaign ? <div className="muted">Selecione uma campanha para ver os registros.</div> : null}

        {selectedCampaign ? (
          <div className="stack">
            <div className="grid four">
              <div className="metric">
                <h3>Selecionados</h3>
                <strong>{selectedCampaign.audienceSnapshot.selectedCount}</strong>
                <p className="muted">Registros materializados no rascunho.</p>
              </div>
              <div className="metric">
                <h3>Após reenvio</h3>
                <strong>{selectedCampaign.audienceSnapshot.afterResendFilterCount}</strong>
                <p className="muted">Elegíveis depois da regra de histórico.</p>
              </div>
              <div className="metric">
                <h3>WhatsApp único</h3>
                <strong>
                  {selectedCampaign.audience.uniqueWhatsAppOnly
                    ? (selectedCampaign.audienceSnapshot.afterUniqueWhatsAppFilterCount ??
                      selectedCampaign.audienceSnapshot.afterResendFilterCount)
                    : 'desligado'}
                </strong>
                <p className="muted">
                  {selectedCampaign.audience.uniqueWhatsAppOnly
                    ? 'Registros após bloquear histórico anterior.'
                    : 'Filtro não aplicado nesta campanha.'}
                </p>
              </div>
              <div className="metric">
                <h3>Entregues</h3>
                <strong>{selectedCampaign.summary.delivered}</strong>
                <p className="muted">Mensagens com status delivered/read.</p>
              </div>
            </div>

            <div className="campaign-summary-grid">
              <div className="notice">
                <strong>Template</strong>
                <div className="muted">{selectedCampaign.template?.name ?? 'Não identificado'}</div>
              </div>
              <div className="notice">
                <strong>Flow</strong>
                <div className="muted">{selectedCampaign.flow?.name ?? 'Sem Flow associado'}</div>
              </div>
              <div className="notice">
                <strong>Lista</strong>
                <div className="muted">{selectedCampaign.list?.name ?? 'Não identificada'}</div>
              </div>
              <div className="notice">
                <strong>Regra de seleção</strong>
                <div className="muted">{describeAudience(selectedCampaign.audience)}</div>
              </div>
            </div>

            <div className="table-wrap">
              <div className="form-actions">
                <div className="muted">
                  Mostrando {selectedCampaign.messages.length ? selectedCampaign.messagesOffset + 1 : 0}
                  {' - '}
                  {selectedCampaign.messagesOffset + selectedCampaign.messages.length}
                  {' de '}
                  {selectedCampaign.messagesTotal} registro(s).
                </div>
                <div className="form-actions">
                  <button
                    className="ghost-button"
                    type="button"
                    disabled={selectedCampaign.messagesOffset === 0}
                    onClick={() =>
                      setMessageOffset((current) => Math.max(0, current - selectedCampaign.messagesLimit))
                    }
                  >
                    Página anterior
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    disabled={!selectedCampaign.messagesHasMore}
                    onClick={() =>
                      setMessageOffset((current) => current + selectedCampaign.messagesLimit)
                    }
                  >
                    Próxima página
                  </button>
                </div>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Cliente</th>
                    <th>Contato</th>
                    <th>Telefone</th>
                    <th>Categoria</th>
                    <th>Status</th>
                    <th>Tentativas</th>
                    <th>Recebida</th>
                    <th>Lida</th>
                    <th>Erro / observação</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedCampaign.messages.length ? (
                    selectedCampaign.messages.map((messageItem) => (
                      <tr key={messageItem.id}>
                        <td>{messageItem.contactClientName ?? '-'}</td>
                        <td>{messageItem.contactName ?? '-'}</td>
                        <td>{messageItem.phoneE164}</td>
                        <td>{messageItem.contactCategory ?? '-'}</td>
                        <td>
                          <span className={`tag ${tagToneForMessage(messageItem.status)}`}>{messageItem.status}</span>
                        </td>
                        <td>{messageItem.attemptCount}</td>
                        <td>{formatTimestamp(messageItem.deliveredAt ?? messageItem.sentAt)}</td>
                        <td>{formatTimestamp(messageItem.readAt)}</td>
                        <td>{messageItem.skipReason ?? messageItem.providerErrorTitle ?? messageItem.providerErrorCode ?? '-'}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={9} className="muted">
                        Nenhum registro materializado nesta campanha.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </SectionCard>
    </AppShell>
  );
}

const formatTimestamp = (value?: string | null): string =>
  value ? new Date(value).toLocaleString('pt-BR') : '-';

const describeAudience = (audience: CampaignAudience): string => {
  const modeText =
    audience.mode === 'fixed_count'
      ? `${audience.fixedCount ?? 0} contato(s)`
      : audience.mode === 'percentage'
        ? `${audience.percentage ?? 0}% da lista`
        : 'toda a lista elegível';

  const orderText =
    audience.orderMode === 'random'
      ? 'ordem aleatória'
      : `ordenado por ${orderFieldOptions.find((item) => item.value === audience.orderField)?.label ?? audience.orderField} (${audience.orderDirection})`;

  const resendText =
    audience.resendPolicy === 'not_delivered'
      ? 'somente quem ainda não recebeu'
      : audience.resendPolicy === 'not_read'
        ? 'somente quem ainda não leu'
        : 'sem filtro de histórico';
  const uniqueText = audience.uniqueWhatsAppOnly
    ? '1 envio por WhatsApp'
    : 'múltiplos envios permitidos';

  return `${modeText} | ${orderText} | ${resendText} | ${uniqueText}`;
};

const tagToneForMessage = (status: string): string => {
  if (['delivered', 'read', 'accepted', 'sent'].includes(status)) {
    return 'success';
  }
  if (['failed', 'cancelled'].includes(status)) {
    return 'danger';
  }
  if (['pending', 'queued', 'paused'].includes(status)) {
    return 'warning';
  }
  return '';
};
