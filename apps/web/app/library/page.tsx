'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell, useShell } from '../../components/app-shell';
import {
  Badge,
  BadgeText,
  Drawer,
  EmptyState,
  ErrorBanner,
  SkeletonRows,
  ToastHost,
  useToasts,
} from '../../components/ui';
import { apiRequest } from '../../lib/api';
import { TEMPLATE_STATUS, badgeFor } from '../../lib/badges';
import { fmtDateTime } from '../../lib/format';
import { isCollosRole } from '../../lib/session';

interface TemplateComponent {
  type?: string;
  format?: string;
  text?: string;
  buttons?: Array<{ type?: string; text?: string }>;
}

interface VariableDescriptor {
  componentType: string;
  placeholderIndex: number;
  label: string;
}

interface Template {
  id: string;
  integrationId: string;
  name: string;
  languageCode: string;
  category: string;
  status: string;
  hasFlowButton: boolean;
  flowButtonMeta?: Record<string, unknown> | null;
  variableDescriptors: VariableDescriptor[];
  components: TemplateComponent[];
  lastSyncedAt: string;
}

interface Integration {
  id: string;
  name: string;
}

const metaStatusBadge = (status: string) =>
  badgeFor(TEMPLATE_STATUS, status.trim().toUpperCase());

export default function LibraryPage() {
  return (
    <AppShell title="Modelos">
      <ModelsContent />
    </AppShell>
  );
}

function ModelsContent() {
  const { session } = useShell();
  const collos = isCollosRole(session.role);
  const { toasts, push } = useToasts();
  const [tab, setTab] = useState<'synced' | 'requests'>('synced');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [detail, setDetail] = useState<Template | null>(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [integrationFilter, setIntegrationFilter] = useState('');
  const [flowFilter, setFlowFilter] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    void apiRequest<Template[]>('/library/templates')
      .then((data) => {
        setTemplates(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar modelos.');
        setLoading(false);
      });
    if (collos) {
      void apiRequest<Integration[]>('/integrations')
        .then(setIntegrations)
        .catch(() => undefined);
    }
  }, [collos]);

  useEffect(() => {
    load();
  }, [load]);

  const integrationName = (id: string): string =>
    integrations.find((i) => i.id === id)?.name ?? '—';

  const categories = useMemo(
    () => Array.from(new Set(templates.map((t) => t.category).filter(Boolean))),
    [templates],
  );
  const statuses = useMemo(
    () => Array.from(new Set(templates.map((t) => t.status.toUpperCase()).filter(Boolean))),
    [templates],
  );

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return templates.filter((t) => {
      if (statusFilter && t.status.toUpperCase() !== statusFilter) return false;
      if (categoryFilter && t.category !== categoryFilter) return false;
      if (integrationFilter && t.integrationId !== integrationFilter) return false;
      if (flowFilter === 'yes' && !t.hasFlowButton) return false;
      if (flowFilter === 'no' && t.hasFlowButton) return false;
      if (term && !t.name.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [templates, search, statusFilter, categoryFilter, integrationFilter, flowFilter]);

  const syncAll = async () => {
    if (integrations.length === 0) {
      push('warning', 'Nenhuma integração para sincronizar.');
      return;
    }
    setSyncing(true);
    const targets = integrationFilter ? integrations.filter((i) => i.id === integrationFilter) : integrations;
    try {
      let total = 0;
      for (const integration of targets) {
        const result = await apiRequest<unknown[]>(`/integrations/${integration.id}/sync/templates`, {
          method: 'POST',
        });
        total += Array.isArray(result) ? result.length : 0;
      }
      push('success', `Modelos sincronizados: ${total}.`);
      load();
    } catch (err) {
      push('danger', err instanceof Error ? err.message : 'Falha ao sincronizar.');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <>
      <div className="op-head">
        <div className="op-head-titles">
          <h1 className="op-title">Modelos</h1>
          <p className="op-sub">Templates de mensagem sincronizados com a Meta.</p>
        </div>
        {collos && tab === 'synced' ? (
          <div className="op-actions">
            <button className="btn primary md" onClick={syncAll} disabled={syncing}>
              {syncing ? 'Sincronizando…' : 'Sincronizar modelos'}
            </button>
          </div>
        ) : null}
      </div>

      <div className="tabs-list page-tabs">
        <button
          className={`tab-trigger${tab === 'synced' ? ' active' : ''}`}
          onClick={() => setTab('synced')}
        >
          Sincronizados
        </button>
        <button
          className={`tab-trigger${tab === 'requests' ? ' active' : ''}`}
          onClick={() => setTab('requests')}
        >
          Solicitações
        </button>
      </div>

      {tab === 'requests' ? (
        <div className="tbl-wrap">
          <EmptyState
            title="Sem solicitações"
            desc="Solicitações de novos modelos aparecerão aqui."
          />
        </div>
      ) : (
        <>
          {error ? <ErrorBanner message={error} onRetry={load} /> : null}

          <div className="toolbar">
            <div className="tb-search">
              <SearchIcon />
              <input placeholder="Buscar modelo" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <select className="flt" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">Status Meta</option>
              {statuses.map((s) => (
                <option key={s} value={s}>
                  {metaStatusBadge(s).label}
                </option>
              ))}
            </select>
            <select className="flt" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
              <option value="">Categoria</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {collos ? (
              <select
                className="flt"
                value={integrationFilter}
                onChange={(e) => setIntegrationFilter(e.target.value)}
              >
                <option value="">Integração</option>
                {integrations.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            ) : null}
            <select className="flt" value={flowFilter} onChange={(e) => setFlowFilter(e.target.value)}>
              <option value="">Tem flow</option>
              <option value="yes">Com flow</option>
              <option value="no">Sem flow</option>
            </select>
          </div>

          <div className="tbl-wrap">
            <table className="tbl dense">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Idioma</th>
                  <th>Categoria</th>
                  <th>Status Meta</th>
                  {collos ? <th>Integração</th> : null}
                  <th>Tem flow</th>
                  <th>Último sync</th>
                  <th></th>
                </tr>
              </thead>
              {loading ? (
                <SkeletonRows rows={6} cols={collos ? 8 : 7} />
              ) : (
                <tbody>
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={collos ? 8 : 7}>
                        <EmptyState title="Nenhum modelo sincronizado" />
                      </td>
                    </tr>
                  ) : (
                    filtered.map((template) => (
                      <tr key={template.id}>
                        <td className="cell-strong">{template.name}</td>
                        <td className="cell-mono">{template.languageCode}</td>
                        <td className="cell-sub">{template.category}</td>
                        <td>
                          <Badge def={metaStatusBadge(template.status)} />
                        </td>
                        {collos ? <td className="cell-sub">{integrationName(template.integrationId)}</td> : null}
                        <td>
                          {template.hasFlowButton ? (
                            <BadgeText label="Sim" cls="info" />
                          ) : (
                            <span className="cell-sub">Não</span>
                          )}
                        </td>
                        <td className="cell-mono">{fmtDateTime(template.lastSyncedAt)}</td>
                        <td>
                          <div className="row-actions">
                            <button className="btn tertiary sm" onClick={() => setDetail(template)}>
                              Ver detalhes
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
        </>
      )}

      {detail ? <TemplateDrawer template={detail} onClose={() => setDetail(null)} /> : null}
      <ToastHost toasts={toasts} />
    </>
  );
}

function TemplateDrawer({ template, onClose }: { template: Template; onClose: () => void }) {
  const header = template.components.find((c) => c.type?.toUpperCase() === 'HEADER');
  const body = template.components.find((c) => c.type?.toUpperCase() === 'BODY');
  const footer = template.components.find((c) => c.type?.toUpperCase() === 'FOOTER');
  const buttonsComp = template.components.find((c) => c.type?.toUpperCase() === 'BUTTONS');

  return (
    <Drawer
      title={template.name}
      subtitle={`${template.languageCode} · ${template.category}`}
      onClose={onClose}
      width={840}
    >
      <div className="dl" style={{ marginBottom: 20 }}>
        <dt>Status Meta</dt>
        <dd>
          <Badge def={metaStatusBadge(template.status)} />
        </dd>
        <dt>Idioma</dt>
        <dd>{template.languageCode}</dd>
        <dt>Categoria</dt>
        <dd>{template.category}</dd>
        <dt>Tem flow</dt>
        <dd>{template.hasFlowButton ? 'Sim' : 'Não'}</dd>
      </div>

      <div className="grid-2">
        <div>
          <div className="block">
            <div className="block-head">
              <span className="block-title">Componentes</span>
            </div>
            <div className="stack">
              {template.components.map((component, index) => (
                <div key={index} className="panel panel--inset" style={{ padding: 14 }}>
                  <div className="flt-label" style={{ marginBottom: 4 }}>
                    {component.type ?? 'COMPONENTE'}
                    {component.format ? ` · ${component.format}` : ''}
                  </div>
                  {component.text ? <div style={{ fontSize: 13.5 }}>{component.text}</div> : null}
                  {component.buttons?.length ? (
                    <div className="row" style={{ marginTop: 6 }}>
                      {component.buttons.map((button, buttonIndex) => (
                        <span key={buttonIndex} className="badge neutral">
                          {button.text ?? button.type}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <div className="block">
            <div className="block-head">
              <span className="block-title">Variáveis detectadas</span>
            </div>
            {template.variableDescriptors.length === 0 ? (
              <div className="cell-sub">Nenhuma variável.</div>
            ) : (
              <div className="row">
                {template.variableDescriptors.map((variable, index) => (
                  <span key={index} className="badge brand-soft">
                    {`{{${variable.placeholderIndex}}}`} · {variable.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div>
          <div className="block">
            <div className="block-head">
              <span className="block-title">Preview no WhatsApp</span>
            </div>
            <div className="wa-preview">
              <div className="wa-bubble">
                {header?.text ? <div className="wa-head">{header.text}</div> : null}
                <div>{body?.text ?? 'Sem corpo de mensagem.'}</div>
                {footer?.text ? <div className="wa-foot">{footer.text}</div> : null}
                <div className="wa-time">agora</div>
                {buttonsComp?.buttons?.length
                  ? buttonsComp.buttons.map((button, index) => (
                      <div key={index} className="wa-btn">
                        {button.text ?? button.type}
                      </div>
                    ))
                  : null}
              </div>
            </div>
            {template.hasFlowButton ? (
              <div className="toast" style={{ marginTop: 12 }}>
                Este modelo possui um flow vinculado.
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </Drawer>
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
