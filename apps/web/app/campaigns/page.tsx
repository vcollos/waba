'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell, useShell } from '../../components/app-shell';
import {
  Badge,
  Drawer,
  EmptyState,
  ErrorBanner,
  Kpi,
  Modal,
  SkeletonRows,
  ToastHost,
  usePagedRows,
  useToasts,
} from '../../components/ui';
import { apiDownload, apiRequest } from '../../lib/api';
import { CAMPAIGN_STATUS, MESSAGE_STATUS, badgeFor } from '../../lib/badges';
import { CampaignFunnel, CampaignSummary } from '../../lib/campaign-metrics';
import { fmtDateTime, fmtInt } from '../../lib/format';
import { canWrite, isCollosRole } from '../../lib/session';

type CampaignMode = 'template' | 'template_flow' | 'session_flow';
type CampaignStatus =
  | 'draft'
  | 'queued'
  | 'sending'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';

interface CampaignItem {
  id: string;
  clientId: string | null;
  name: string;
  status: CampaignStatus;
  mode: CampaignMode;
  integrationId: string;
  templateCacheId: string | null;
  flowCacheId: string | null;
  listId: string;
  sendRateMps: number;
  summary: CampaignSummary;
  funnel: CampaignFunnel;
  createdAt: string;
  template?: { name: string } | null;
  list?: { name: string } | null;
}

interface Integration {
  id: string;
  name: string;
  clientId: string | null;
  /** Tenants com acesso — a mesma conta WABA pode servir vários. */
  clientIds: string[];
}
interface ListItem {
  id: string;
  clientId?: string | null;
  name: string;
}

interface ListFilterField {
  key: string;
  label: string;
  values: string[];
  totalDistinct: number;
  truncated: boolean;
}

interface ListFilterOptions {
  listId: string;
  fields: ListFilterField[];
}
const MEDIA_LABEL: Record<'IMAGE' | 'VIDEO' | 'DOCUMENT', string> = {
  IMAGE: 'Imagem',
  VIDEO: 'Vídeo',
  DOCUMENT: 'Documento',
};

interface Template {
  id: string;
  name: string;
  integrationId: string;
  hasFlowButton: boolean;
  variableDescriptors: Array<{
    componentType: string;
    placeholderIndex: number;
    label: string;
    paramName?: string | null;
    example?: string | null;
    buttonUrlBase?: string | null;
  }>;
  mediaHeader?: { format: 'IMAGE' | 'VIDEO' | 'DOCUMENT'; example?: string | null } | null;
}

export default function CampaignsPage() {
  return (
    <AppShell title="Campanhas">
      <CampaignsContent />
    </AppShell>
  );
}

function CampaignsContent() {
  const { session, clients, scopeClientId } = useShell();
  const collos = isCollosRole(session.role);
  const writable = canWrite(session.role);
  const { toasts, push } = useToasts();
  const [campaigns, setCampaigns] = useState<CampaignItem[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [lists, setLists] = useState<ListItem[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState('');
  const [templateFilter, setTemplateFilter] = useState('');
  const [listFilter, setListFilter] = useState('');

  const [detailId, setDetailId] = useState<string | null>(null);
  const [wizard, setWizard] = useState(false);

  const load = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    const scopeQuery = scopeClientId ? `?clientId=${encodeURIComponent(scopeClientId)}` : '';
    Promise.all([
      apiRequest<CampaignItem[]>(`/campaigns${scopeQuery}`, { signal }),
      apiRequest<ListItem[]>(`/lists${scopeQuery}`, { signal }),
      apiRequest<Template[]>(`/library/templates${scopeQuery}`, { signal }),
    ])
      .then(([camps, listsData, templatesData]) => {
        if (signal?.aborted) return;
        setCampaigns(camps);
        setLists(listsData);
        setTemplates(templatesData);
        setLoading(false);
      })
      .catch((err) => {
        if (signal?.aborted) return;
        setError(err instanceof Error ? err.message : 'Falha ao carregar campanhas.');
        setLoading(false);
      });
    void apiRequest<Integration[]>('/integrations', { signal })
      .then((data) => {
        if (!signal?.aborted) setIntegrations(data);
      })
      .catch(() => undefined);
  }, [scopeClientId]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const clientName = (id: string | null): string =>
    id ? clients.find((c) => c.id === id)?.name ?? '—' : 'Pool Collos';

  const filtered = useMemo(() => {
    return campaigns.filter((c) => {
      if (scopeClientId && c.clientId !== scopeClientId) return false;
      if (statusFilter && c.status !== statusFilter) return false;
      if (templateFilter && c.templateCacheId !== templateFilter) return false;
      if (listFilter && c.listId !== listFilter) return false;
      return true;
    });
  }, [campaigns, scopeClientId, statusFilter, templateFilter, listFilter]);

  const { pageRows, pager } = usePagedRows(filtered, 'campanha(s)');

  const runAction = async (id: string, path: string, method: string, success: string) => {
    setBusy(`${id}:${path}`);
    try {
      await apiRequest(`/campaigns/${id}${path}`, { method });
      push('success', success);
      load();
    } catch (err) {
      push('danger', err instanceof Error ? err.message : 'Falha na ação.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="op-head">
        <div className="op-head-titles">
          <h1 className="op-title">Campanhas</h1>
          <p className="op-sub">Disparos de template e flow via WhatsApp Business.</p>
        </div>
        {writable ? (
          <div className="op-actions">
            <button className="btn primary md" onClick={() => setWizard(true)}>
              Nova campanha
            </button>
          </div>
        ) : null}
      </div>

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}

      <div className="toolbar">
        <select className="flt" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">Status</option>
          {Object.entries(CAMPAIGN_STATUS).map(([value, def]) => (
            <option key={value} value={value}>
              {def.label}
            </option>
          ))}
        </select>
        <select className="flt" value={templateFilter} onChange={(e) => setTemplateFilter(e.target.value)}>
          <option value="">Template</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select className="flt" value={listFilter} onChange={(e) => setListFilter(e.target.value)}>
          <option value="">Lista</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>

      <div className="tbl-wrap">
        <table className="tbl dense">
          <thead>
            <tr>
              <th>Nome</th>
              {collos ? <th>Cliente</th> : null}
              <th>Template</th>
              <th>Lista</th>
              <th>Status</th>
              <th className="num">Total</th>
              <th className="num">Pendentes</th>
              <th className="num">Enviadas</th>
              <th className="num">Entregues</th>
              <th className="num">Lidas</th>
              <th className="num">Falhas</th>
              <th>Criada em</th>
              <th></th>
            </tr>
          </thead>
          {loading ? (
            <SkeletonRows rows={6} cols={collos ? 13 : 12} />
          ) : (
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={collos ? 13 : 12}>
                    <EmptyState title="Nenhuma campanha" />
                  </td>
                </tr>
              ) : (
                pageRows.map((c) => (
                  <tr key={c.id}>
                    <td className="cell-strong">{c.name}</td>
                    {collos ? <td className="cell-sub">{clientName(c.clientId)}</td> : null}
                    <td className="cell-sub">{c.template?.name ?? '—'}</td>
                    <td className="cell-sub">{c.list?.name ?? '—'}</td>
                    <td>
                      <Badge def={badgeFor(CAMPAIGN_STATUS, c.status)} />
                    </td>
                    {/* Funil acumulado (não os baldes de `summary`): Enviadas >= Entregues >= Lidas. */}
                    <td className="num">{fmtInt(c.funnel.total)}</td>
                    <td className="num">{fmtInt(c.funnel.pending)}</td>
                    <td className="num">{fmtInt(c.funnel.sentTotal)}</td>
                    <td className="num">{fmtInt(c.funnel.deliveredTotal)}</td>
                    <td className="num">{fmtInt(c.funnel.readTotal)}</td>
                    <td className="num">{fmtInt(c.funnel.failed)}</td>
                    <td className="cell-mono">{fmtDateTime(c.createdAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button className="btn tertiary sm" onClick={() => setDetailId(c.id)}>
                          Detalhes
                        </button>
                        {writable ? <CampaignActions campaign={c} busy={busy} run={runAction} /> : null}
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

      {detailId ? (
        <CampaignDrawer id={detailId} scopeClientId={scopeClientId} onClose={() => setDetailId(null)} />
      ) : null}

      {wizard ? (
        <CampaignWizard
          key={scopeClientId ?? 'all-clients'}
          collos={collos}
          initialClientId={scopeClientId}
          clients={clients}
          integrations={integrations}
          lists={lists}
          templates={templates}
          onClose={() => setWizard(false)}
          onCreated={() => {
            setWizard(false);
            push('success', 'Rascunho de campanha criado.');
            load();
          }}
        />
      ) : null}

      <ToastHost toasts={toasts} />
    </>
  );
}

function CampaignActions({
  campaign,
  busy,
  run,
}: {
  campaign: CampaignItem;
  busy: string | null;
  run: (id: string, path: string, method: string, success: string) => void;
}) {
  const disabled = busy !== null;
  const s = campaign.status;
  return (
    <>
      {s === 'draft' || s === 'queued' ? (
        <button className="btn secondary sm" disabled={disabled} onClick={() => run(campaign.id, '/start', 'POST', 'Campanha iniciada.')}>
          Iniciar
        </button>
      ) : null}
      {s === 'sending' ? (
        <button className="btn secondary sm" disabled={disabled} onClick={() => run(campaign.id, '/pause', 'POST', 'Campanha pausada.')}>
          Pausar
        </button>
      ) : null}
      {s === 'paused' ? (
        <button className="btn secondary sm" disabled={disabled} onClick={() => run(campaign.id, '/resume', 'POST', 'Campanha retomada.')}>
          Retomar
        </button>
      ) : null}
      {campaign.summary.failed > 0 ? (
        <button className="btn secondary sm" disabled={disabled} onClick={() => run(campaign.id, '/retry-failed', 'POST', 'Reenvio de falhas iniciado.')}>
          Reenviar falhas
        </button>
      ) : null}
      {s === 'draft' ? (
        <button className="btn danger sm" disabled={disabled} onClick={() => run(campaign.id, '', 'DELETE', 'Rascunho excluído.')}>
          Excluir
        </button>
      ) : null}
    </>
  );
}

interface CampaignDetail extends CampaignItem {
  flow?: { name: string } | null;
  messages: Array<{
    id: string;
    contactName: string | null;
    phoneE164: string;
    status: string;
    attemptCount: number;
    providerMessageId: string | null;
    providerErrorMessage: string | null;
    sentAt: string | null;
    deliveredAt: string | null;
    readAt: string | null;
  }>;
}

function CampaignDrawer({
  id,
  scopeClientId,
  onClose,
}: {
  id: string;
  scopeClientId: string | null;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setLoading(true);
    void apiRequest<CampaignDetail>(`/campaigns/${id}?limit=100&offset=0`)
      .then((data) => {
        setDetail(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar campanha.');
        setLoading(false);
      });
  }, [id]);

  const exportReport = async () => {
    setExporting(true);
    setError(null);
    try {
      const qs = scopeClientId ? `?clientId=${encodeURIComponent(scopeClientId)}` : '';
      await apiDownload(`/campaigns/${id}/export.csv${qs}`, `campanha-${id}.csv`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao exportar relatório.');
    } finally {
      setExporting(false);
    }
  };

  const f = detail?.funnel;
  const pct = (value: number | undefined): string =>
    `${(value ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% do total`;
  const sentRate = f && f.total ? Number(((f.sentTotal / f.total) * 100).toFixed(1)) : 0;

  return (
    <Drawer
      title={detail?.name ?? 'Campanha'}
      subtitle={detail ? undefined : 'Carregando…'}
      onClose={onClose}
      width={840}
      actions={
        detail ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn secondary sm" onClick={exportReport} disabled={exporting}>
              {exporting ? 'Exportando…' : 'Exportar relatório'}
            </button>
            <Badge def={badgeFor(CAMPAIGN_STATUS, detail.status)} />
          </div>
        ) : undefined
      }
    >
      {error ? <ErrorBanner message={error} /> : null}
      {loading || !detail ? (
        <div className="kpi-grid">
          <KpiSkeletonInline />
        </div>
      ) : (
        <>
          {/*
            Duas leituras distintas, deliberadamente separadas:
            - Funil: acumulado. Cada etapa é subconjunto da anterior
              (Total >= Enviadas >= Entregues >= Lidas). NÃO soma `total`.
            - Situação atual: baldes de `summary`, mutuamente excludentes.
            Misturar os dois num grid só (como antes) fazia o cliente somar
            colunas que não somam e ver "Entregues < Lidas".
          */}
          <div className="block">
            <div className="block-head">
              <span className="block-title">Funil</span>
            </div>
            <div className="kpi-grid">
              <Kpi label="Total" value={fmtInt(f?.total)} foot="Público da campanha" />
              <Kpi label="Enviadas" value={fmtInt(f?.sentTotal)} foot={pct(sentRate)} />
              <Kpi label="Entregues" value={fmtInt(f?.deliveredTotal)} foot={pct(f?.deliveryRate)} />
              <Kpi label="Lidas" value={fmtInt(f?.readTotal)} foot={pct(f?.readRate)} />
            </div>
            <span className="hint">
              Cada etapa inclui as seguintes: das {fmtInt(f?.total)} mensagens,{' '}
              {fmtInt(f?.deliveredTotal)} chegaram ao aparelho e {fmtInt(f?.readTotal)} foram lidas.
            </span>
          </div>

          <div className="block">
            <div className="block-head">
              <span className="block-title">Situação atual</span>
            </div>
            <div className="kpi-grid">
              <Kpi label="Pendentes" value={fmtInt(f?.pending)} foot="Ainda na fila" />
              <Kpi label="Aceitas" value={fmtInt(f?.accepted)} foot="Na Meta, sem confirmação" />
              <Kpi label="Falhas" value={fmtInt(f?.failed)} foot="Fora do funil" />
              <Kpi label="Ignoradas" value={fmtInt(f?.skipped)} foot="Fora do funil" />
            </div>
          </div>

          <div className="block">
            <div className="block-head">
              <span className="block-title">Configuração</span>
            </div>
            <div className="dl">
              <dt>Template</dt>
              <dd>{detail.template?.name ?? '—'}</dd>
              <dt>Flow</dt>
              <dd>{detail.flow?.name ?? '—'}</dd>
              <dt>Lista</dt>
              <dd>{detail.list?.name ?? '—'}</dd>
              <dt>Taxa de envio</dt>
              <dd>{detail.sendRateMps} msg/s</dd>
            </div>
          </div>

          <div className="block">
            <div className="block-head">
              <span className="block-title">Mensagens</span>
            </div>
            <div className="tbl-wrap">
              <table className="tbl dense">
                <thead>
                  <tr>
                    <th>Contato</th>
                    <th>WhatsApp</th>
                    <th>Status</th>
                    <th className="num">Tentativas</th>
                    <th>Provider Message ID</th>
                    <th>Erro</th>
                    <th>Enviada em</th>
                    <th>Entregue em</th>
                    <th>Lida em</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.messages.length === 0 ? (
                    <tr>
                      <td colSpan={9}>
                        <EmptyState title="Sem mensagens" />
                      </td>
                    </tr>
                  ) : (
                    detail.messages.map((m) => (
                      <tr key={m.id}>
                        <td className="cell-sub">{m.contactName ?? '—'}</td>
                        <td className="cell-mono">{m.phoneE164}</td>
                        <td>
                          <Badge def={badgeFor(MESSAGE_STATUS, m.status)} />
                        </td>
                        <td className="num">{m.attemptCount}</td>
                        <td className="cell-mono">{m.providerMessageId ?? '—'}</td>
                        <td className="cell-sub">{m.providerErrorMessage ?? '—'}</td>
                        <td className="cell-mono">{fmtDateTime(m.sentAt)}</td>
                        <td className="cell-mono">{fmtDateTime(m.deliveredAt)}</td>
                        <td className="cell-mono">{fmtDateTime(m.readAt)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </Drawer>
  );
}

function KpiSkeletonInline() {
  return (
    <>
      {Array.from({ length: 4 }).map((_, i) => (
        <div className="kpi" key={i}>
          <span className="skel" style={{ display: 'block', height: 12, width: '60%' }} />
          <span className="skel" style={{ display: 'block', height: 22, width: '40%', marginTop: 6 }} />
        </div>
      ))}
    </>
  );
}

type ParamSource =
  | { type: 'static'; value: string }
  | { type: 'contact_name' }
  | { type: 'contact_phone' }
  | { type: 'contact_email' }
  | { type: 'contact_attribute'; key: string }
  | { type: 'contact_field'; key: string };

const CONTACT_FIELD_SOURCE_PREFIX = 'contact_field:';

function contactFieldKey(source: ParamSource | undefined): string | null {
  if (!source || source.type === 'static') return null;
  if (source.type === 'contact_field') return source.key;
  if (source.type === 'contact_name') return 'name';
  if (source.type === 'contact_phone') return 'phoneE164';
  if (source.type === 'contact_email') return 'email';
  return source.key.startsWith('attributes.') ? source.key : `attributes.${source.key}`;
}

function contactFieldFallbackLabel(key: string): string {
  const knownLabels: Record<string, string> = {
    name: 'Nome completo',
    firstName: 'Nome',
    lastName: 'Sobrenome',
    phoneE164: 'WhatsApp',
    email: 'E-mail',
    category: 'Categoria',
    clientName: 'Cliente',
    externalRef: 'Referência externa',
  };
  return knownLabels[key] ?? key.replace(/^attributes\./, 'Campo personalizado · ');
}

function paramSourceSelectValue(source: ParamSource | undefined): string {
  if (!source || source.type === 'static') return 'static';
  return `${CONTACT_FIELD_SOURCE_PREFIX}${contactFieldKey(source)}`;
}

function buildDefaultParameterMapping(template: Template | null): Record<string, ParamSource> {
  if (!template) return {};

  const next: Record<string, ParamSource> = {};
  for (const descriptor of template.variableDescriptors) {
    const key = `${descriptor.componentType}:${descriptor.placeholderIndex}`;
    if (descriptor.componentType === 'button') {
      // O exemplo da Meta para botão contém a URL completa, mas o envio aceita só o sufixo.
      next[key] = { type: 'static', value: '' };
    } else {
      next[key] = descriptor.example
        ? { type: 'static', value: descriptor.example }
        : { type: 'contact_name' };
    }
  }

  // O header_handle de exemplo da Meta pode expirar ou devolver 403 no envio.
  if (template.mediaHeader) next['header:media'] = { type: 'static', value: '' };
  return next;
}

function CampaignWizard({
  collos,
  initialClientId,
  clients,
  integrations,
  lists,
  templates,
  onClose,
  onCreated,
}: {
  collos: boolean;
  initialClientId: string | null;
  clients: Array<{ id: string; name: string }>;
  integrations: Integration[];
  lists: ListItem[];
  templates: Template[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [clientId, setClientId] = useState(initialClientId ?? '');
  const [integrationId, setIntegrationId] = useState('');
  const [mode, setMode] = useState<CampaignMode>('template');
  const [templateId, setTemplateId] = useState('');
  const [listId, setListId] = useState('');
  const [filterOptions, setFilterOptions] = useState<ListFilterField[]>([]);
  const [filterOptionsLoading, setFilterOptionsLoading] = useState(false);
  const [filterOptionsError, setFilterOptionsError] = useState<string | null>(null);
  const [filterField, setFilterField] = useState('');
  const [filterValue, setFilterValue] = useState('');
  const [audienceMode, setAudienceMode] = useState<'all' | 'fixed_count' | 'percentage'>('all');
  const [fixedCount, setFixedCount] = useState('');
  const [percentage, setPercentage] = useState('');
  const [orderMode, setOrderMode] = useState<'field' | 'random'>('field');
  const [orderDirection, setOrderDirection] = useState<'asc' | 'desc'>('asc');
  const [resendPolicy, setResendPolicy] = useState<'all' | 'not_delivered' | 'not_read'>('all');
  const [uniqueWhatsApp, setUniqueWhatsApp] = useState(false);
  const [mapping, setMapping] = useState<Record<string, ParamSource>>({});
  const [sendRate, setSendRate] = useState('20');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filterOptionsRequest = useRef(0);

  const visibleIntegrations = useMemo(
    () =>
      clientId
        ? integrations.filter((i) => i.clientIds.includes(clientId))
        : integrations,
    [clientId, integrations],
  );
  const visibleLists = useMemo(() => {
    if (!clientId) return [];
    return lists.filter((list) => {
      if (list.clientId !== undefined) return list.clientId === clientId;
      // Compatibilidade transitória: uma resposta antiga sem clientId só é
      // segura quando já veio escopada pelo tenant ativo da topbar.
      return initialClientId === clientId;
    });
  }, [clientId, initialClientId, lists]);
  const visibleTemplates = useMemo(
    () => templates.filter((item) => !integrationId || item.integrationId === integrationId),
    [integrationId, templates],
  );
  const template = useMemo(
    () => visibleTemplates.find((item) => item.id === templateId) ?? null,
    [templateId, visibleTemplates],
  );
  const selectedFilterField = useMemo(
    () => filterOptions.find((field) => field.key === filterField) ?? null,
    [filterField, filterOptions],
  );
  const filterOptionKeys = useMemo(
    () => new Set(filterOptions.map((field) => field.key)),
    [filterOptions],
  );

  const resetAudienceFilter = () => {
    filterOptionsRequest.current += 1;
    setListId('');
    setFilterOptions([]);
    setFilterOptionsLoading(false);
    setFilterOptionsError(null);
    setFilterField('');
    setFilterValue('');
  };

  const handleClientChange = (nextClientId: string) => {
    setClientId(nextClientId);
    setIntegrationId('');
    setTemplateId('');
    setMapping({});
    resetAudienceFilter();
  };

  const handleIntegrationChange = (nextIntegrationId: string) => {
    setIntegrationId(nextIntegrationId);
    setTemplateId('');
    setMapping({});
  };

  const loadFilterOptions = async (selectedListId: string) => {
    const requestId = filterOptionsRequest.current + 1;
    filterOptionsRequest.current = requestId;
    setFilterOptions([]);
    setFilterOptionsError(null);
    setFilterOptionsLoading(true);
    try {
      const scopeQuery = clientId ? `?clientId=${encodeURIComponent(clientId)}` : '';
      const result = await apiRequest<ListFilterOptions>(
        `/lists/${encodeURIComponent(selectedListId)}/filter-options${scopeQuery}`,
      );
      if (filterOptionsRequest.current !== requestId) return;
      setFilterOptions(result.fields);
    } catch (err) {
      if (filterOptionsRequest.current !== requestId) return;
      setFilterOptionsError(
        err instanceof Error ? err.message : 'Falha ao carregar os campos desta lista.',
      );
    } finally {
      if (filterOptionsRequest.current === requestId) setFilterOptionsLoading(false);
    }
  };

  const handleListChange = (nextListId: string) => {
    filterOptionsRequest.current += 1;
    setListId(nextListId);
    setMapping(buildDefaultParameterMapping(template));
    setFilterOptions([]);
    setFilterOptionsLoading(false);
    setFilterOptionsError(null);
    setFilterField('');
    setFilterValue('');
    if (nextListId) void loadFilterOptions(nextListId);
  };

  // Cada template começa com defaults determinísticos. A troca de lista reutiliza
  // o mesmo construtor para nunca carregar um contact_field da lista anterior.
  useEffect(() => {
    setMapping(buildDefaultParameterMapping(template));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  const setVar = (key: string, source: ParamSource) => setMapping((c) => ({ ...c, [key]: source }));

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const audience: Record<string, unknown> = {
        mode: audienceMode,
        orderMode,
        orderDirection,
        resendPolicy,
        uniqueWhatsAppOnly: uniqueWhatsApp,
        filterField: filterField || null,
        filterValue: filterValue.trim() || null,
      };
      if (audienceMode === 'fixed_count') audience.fixedCount = Number(fixedCount) || 0;
      if (audienceMode === 'percentage') audience.percentage = Number(percentage) || 0;

      await apiRequest('/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name,
          // Numa conta WABA compartilhada é este campo que decide de quem é a
          // campanha (e o custo); sem ele cairia no tenant principal.
          clientId: clientId || undefined,
          integrationId,
          listId,
          mode,
          templateCacheId: templateId || undefined,
          sendRateMps: Number(sendRate) || 20,
          parameterMapping: mapping,
          audience,
        }),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao criar campanha.');
      setSaving(false);
    }
  };

  const steps = ['Configuração', 'Público', 'Variáveis', 'Revisão'];
  const hasCompleteFilter =
    (!filterField && !filterValue.trim()) || Boolean(filterField && filterValue.trim());
  const hasValidDynamicMappings = Object.values(mapping).every((source) => {
    const fieldKey = contactFieldKey(source);
    return !fieldKey || filterOptionKeys.has(fieldKey);
  });
  const canNext =
    (step === 1 && name && integrationId && templateId && (!collos || clientId)) ||
    (step === 2 &&
      listId &&
      hasCompleteFilter &&
      !filterOptionsLoading &&
      !filterOptionsError) ||
    (step === 3 && hasValidDynamicMappings);

  return (
    <Modal
      title="Nova campanha"
      width="xwide"
      onClose={onClose}
      footer={
        <>
          {error ? (
            <span className="left" style={{ color: 'var(--danger)', fontSize: 13 }}>
              {error}
            </span>
          ) : null}
          {step > 1 ? (
            <button className="btn tertiary md" onClick={() => setStep(step - 1)} disabled={saving}>
              Voltar
            </button>
          ) : null}
          {step < 4 ? (
            <button className="btn primary md" onClick={() => setStep(step + 1)} disabled={!canNext}>
              Continuar
            </button>
          ) : (
            <button className="btn primary md" onClick={submit} disabled={saving}>
              {saving ? 'Criando…' : 'Criar rascunho'}
            </button>
          )}
        </>
      }
    >
      <div className="stepper" style={{ marginBottom: 22 }}>
        {steps.map((label, index) => {
          const n = index + 1;
          const cls = step === n ? 'on' : step > n ? 'done' : '';
          return (
            <div key={label} style={{ display: 'flex', alignItems: 'center' }}>
              <div className={`step ${cls}`}>
                <span className="step-dot">{step > n ? '✓' : n}</span>
                <span className="step-name">{label}</span>
              </div>
              {n < steps.length ? <span className={`step-bar${step > n ? ' done' : ''}`} /> : null}
            </div>
          );
        })}
      </div>

      {step === 1 ? (
        <div className="form-grid">
          <div className="field col-2">
            <label>
              Nome <span className="req">*</span>
            </label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          {collos ? (
            <div className="field">
              <label>
                Cliente <span className="req">*</span>
              </label>
              <select
                className="input"
                value={clientId}
                disabled={Boolean(initialClientId)}
                onChange={(e) => handleClientChange(e.target.value)}
              >
                <option value="">Selecione</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {initialClientId ? (
                <span className="hint">Cliente definido pelo filtro ativo da barra superior.</span>
              ) : null}
            </div>
          ) : null}
          <div className="field">
            <label>
              Integração <span className="req">*</span>
            </label>
            <select
              className="input"
              value={integrationId}
              onChange={(e) => handleIntegrationChange(e.target.value)}
            >
              <option value="">Selecione</option>
              {visibleIntegrations.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Modo</label>
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value as CampaignMode)}>
              <option value="template">Template</option>
              <option value="template_flow">Template + Flow</option>
              <option value="session_flow">Flow de sessão</option>
            </select>
          </div>
          <div className="field">
            <label>
              Template <span className="req">*</span>
            </label>
            <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Selecione</option>
              {visibleTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="form-grid">
          <div className="field">
            <label>
              Lista <span className="req">*</span>
            </label>
            <select
              className="input"
              value={listId}
              disabled={!clientId}
              onChange={(e) => handleListChange(e.target.value)}
            >
              <option value="">{clientId ? 'Selecione' : 'Selecione primeiro o cliente'}</option>
              {visibleLists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            {clientId && visibleLists.length === 0 ? (
              <span className="hint">Este cliente ainda não possui listas disponíveis.</span>
            ) : null}
          </div>
          <div className="field">
            <label>Campo do filtro</label>
            <select
              className="input"
              value={filterField}
              disabled={!listId || filterOptionsLoading || Boolean(filterOptionsError)}
              onChange={(e) => {
                setFilterField(e.target.value);
                setFilterValue('');
              }}
            >
              <option value="">
                {filterOptionsLoading
                  ? 'Carregando campos…'
                  : filterOptions.length > 0
                    ? 'Sem filtro'
                    : 'Nenhum campo disponível'}
              </option>
              {filterOptions.map((field) => (
                <option key={field.key} value={field.key}>
                  {field.label}
                </option>
              ))}
            </select>
            {filterOptionsError ? (
              <span className="hint" style={{ color: 'var(--danger)' }}>
                {filterOptionsError}{' '}
                <button
                  type="button"
                  className="btn tertiary sm"
                  onClick={() => void loadFilterOptions(listId)}
                >
                  Tentar novamente
                </button>
              </span>
            ) : null}
          </div>
          <div className="field">
            <label>Valor do filtro</label>
            <input
              className="input"
              list="campaign-filter-values"
              value={filterValue}
              disabled={!filterField}
              placeholder={filterField ? 'Selecione ou digite um valor' : 'Escolha um campo'}
              onChange={(e) => setFilterValue(e.target.value)}
            />
            <datalist id="campaign-filter-values">
              {(selectedFilterField?.values ?? []).map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
            {selectedFilterField ? (
              <span className="hint">
                {selectedFilterField.truncated
                  ? `Exibindo ${selectedFilterField.values.length} de ${selectedFilterField.totalDistinct} valores; você também pode digitar outro.`
                  : `${selectedFilterField.totalDistinct} valor(es) disponível(is) nesta lista.`}
              </span>
            ) : null}
          </div>
          <div className="field">
            <label>Modo de audiência</label>
            <select className="input" value={audienceMode} onChange={(e) => setAudienceMode(e.target.value as typeof audienceMode)}>
              <option value="all">Todos os elegíveis</option>
              <option value="fixed_count">Quantidade fixa</option>
              <option value="percentage">Percentual</option>
            </select>
          </div>
          {audienceMode === 'fixed_count' ? (
            <div className="field">
              <label>Quantidade fixa</label>
              <input className="input" type="number" value={fixedCount} onChange={(e) => setFixedCount(e.target.value)} />
            </div>
          ) : null}
          {audienceMode === 'percentage' ? (
            <div className="field">
              <label>Percentual (%)</label>
              <input className="input" type="number" value={percentage} onChange={(e) => setPercentage(e.target.value)} />
            </div>
          ) : null}
          <div className="field">
            <label>Ordem</label>
            <select className="input" value={orderMode} onChange={(e) => setOrderMode(e.target.value as typeof orderMode)}>
              <option value="field">Por campo</option>
              <option value="random">Aleatória</option>
            </select>
          </div>
          <div className="field">
            <label>Direção</label>
            <select className="input" value={orderDirection} onChange={(e) => setOrderDirection(e.target.value as typeof orderDirection)}>
              <option value="asc">Crescente</option>
              <option value="desc">Decrescente</option>
            </select>
          </div>
          <div className="field">
            <label>Política de reenvio</label>
            <select className="input" value={resendPolicy} onChange={(e) => setResendPolicy(e.target.value as typeof resendPolicy)}>
              <option value="all">Todos</option>
              <option value="not_delivered">Não entregues</option>
              <option value="not_read">Não lidos</option>
            </select>
          </div>
          <div className="field">
            <label>WhatsApp único</label>
            <select className="input" value={uniqueWhatsApp ? 'yes' : 'no'} onChange={(e) => setUniqueWhatsApp(e.target.value === 'yes')}>
              <option value="no">Não</option>
              <option value="yes">Sim</option>
            </select>
          </div>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="stack">
          {template?.mediaHeader ? (
            <div className="panel panel--inset" style={{ padding: 14 }}>
              <div className="field">
                <label>
                  Mídia do cabeçalho · {MEDIA_LABEL[template.mediaHeader.format]}{' '}
                  <span className="req">*</span>
                </label>
                <input
                  className="input"
                  placeholder="URL pública da mídia"
                  value={mapping['header:media']?.type === 'static' ? mapping['header:media'].value : ''}
                  onChange={(e) => setVar('header:media', { type: 'static', value: e.target.value })}
                />
                <span className="hint">
                  Este template exige uma {MEDIA_LABEL[template.mediaHeader.format].toLowerCase()} no
                  topo. Cole uma URL <strong>pública</strong> (que abra no navegador sem login) — a
                  imagem de exemplo da Meta não funciona como link de envio.
                </span>
              </div>
            </div>
          ) : null}

          {template && template.variableDescriptors.length > 0
            ? template.variableDescriptors.map((descriptor) => {
                const key = `${descriptor.componentType}:${descriptor.placeholderIndex}`;
                const source = mapping[key];
                const selectedContactField = contactFieldKey(source);
                const selectedFieldIsAvailable = selectedContactField
                  ? filterOptions.some((field) => field.key === selectedContactField)
                  : false;
                const isButton = descriptor.componentType === 'button';
                const varName = descriptor.paramName
                  ? `{{${descriptor.paramName}}}`
                  : `{{${descriptor.placeholderIndex}}}`;
                const fieldLabel = isButton
                  ? descriptor.label || 'Botão'
                  : `${descriptor.componentType === 'header' ? 'Cabeçalho' : 'Corpo'} · ${varName}`;
                return (
                  <div key={key} className="form-grid" style={{ alignItems: 'end' }}>
                    <div className="field">
                      <label>{fieldLabel}</label>
                      {isButton && descriptor.buttonUrlBase ? (
                        <span className="hint">
                          Link do botão. A base é fixa no template (
                          <code>{descriptor.buttonUrlBase}</code>) — informe apenas o valor da
                          variável, que a Meta concatena ao final da URL.
                        </span>
                      ) : null}
                      <select
                        className="input"
                        value={paramSourceSelectValue(source)}
                        onChange={(e) => {
                          const value = e.target.value;
                          if (value === 'static') {
                            setVar(key, {
                              type: 'static',
                              value: isButton ? '' : descriptor.example ?? '',
                            });
                            return;
                          }
                          setVar(key, {
                            type: 'contact_field',
                            key: value.slice(CONTACT_FIELD_SOURCE_PREFIX.length),
                          });
                        }}
                      >
                        <option value="static">Valor fixo</option>
                        {filterOptions.length > 0 ? (
                          <optgroup label="Campos da lista selecionada">
                            {filterOptions.map((field) => (
                              <option
                                key={field.key}
                                value={`${CONTACT_FIELD_SOURCE_PREFIX}${field.key}`}
                              >
                                {field.label}
                              </option>
                            ))}
                          </optgroup>
                        ) : null}
                        {selectedContactField && !selectedFieldIsAvailable ? (
                          <option value={`${CONTACT_FIELD_SOURCE_PREFIX}${selectedContactField}`}>
                            {contactFieldFallbackLabel(selectedContactField)} (mapeamento existente)
                          </option>
                        ) : null}
                      </select>
                      {selectedContactField && !selectedFieldIsAvailable ? (
                        <span className="hint" style={{ color: 'var(--danger)' }}>
                          Este campo não existe na lista atual. Escolha outro campo ou use um valor
                          fixo.
                        </span>
                      ) : filterOptions.length === 0 ? (
                        <span className="hint">
                          Esta lista não possui campos preenchidos disponíveis para mapeamento.
                        </span>
                      ) : null}
                    </div>
                    {source?.type === 'static' ? (
                      <div className="field">
                        <label>Valor</label>
                        <input
                          className="input"
                          placeholder={isButton ? 'valor da variável do link' : descriptor.example ?? ''}
                          value={source.value}
                          onChange={(e) => setVar(key, { type: 'static', value: e.target.value })}
                        />
                      </div>
                    ) : null}
                  </div>
                );
              })
            : null}

          {!template?.mediaHeader && (!template || template.variableDescriptors.length === 0) ? (
            <div className="cell-sub">Este template não possui variáveis para preencher.</div>
          ) : null}
        </div>
      ) : null}

      {step === 4 ? (
        <>
          <div className="dl" style={{ marginBottom: 18 }}>
            <dt>Nome</dt>
            <dd>{name}</dd>
            <dt>Integração</dt>
            <dd>{integrations.find((i) => i.id === integrationId)?.name ?? '—'}</dd>
            <dt>Template</dt>
            <dd>{template?.name ?? '—'}</dd>
            <dt>Lista</dt>
            <dd>{visibleLists.find((l) => l.id === listId)?.name ?? '—'}</dd>
            <dt>Filtro</dt>
            <dd>
              {selectedFilterField && filterValue.trim()
                ? `${selectedFilterField.label}: ${filterValue.trim()}`
                : 'Sem filtro'}
            </dd>
            <dt>Modo de audiência</dt>
            <dd>{audienceMode}</dd>
          </div>
          <div className="field" style={{ maxWidth: 220 }}>
            <label>Taxa de envio (msg/s)</label>
            <input className="input" type="number" min={1} max={80} value={sendRate} onChange={(e) => setSendRate(e.target.value)} />
          </div>
        </>
      ) : null}
    </Modal>
  );
}
