'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../../components/app-shell';
import { SectionCard } from '../../components/section-card';
import { apiRequest } from '../../lib/api';

interface Template {
  id: string;
  name: string;
  languageCode: string;
  category: string;
  status: string;
  hasFlowButton: boolean;
  variableDescriptors: Array<{ label: string }>;
}

interface Flow {
  id: string;
  name: string;
  status: string;
  categories: string[];
  previewUrl?: string | null;
  completionPayloadDefinitions?: Array<{
    screenId: string;
    formName?: string | null;
    actionName: string;
    payloadFields: Array<{
      key: string;
      sourceType: 'form' | 'static' | 'expression';
      sourceField?: string | null;
      expression?: string | null;
      staticValue?: string | null;
    }>;
  }> | null;
}

function getStatusTone(status: string) {
  const normalized = status.trim().toUpperCase();

  if (['APPROVED', 'PUBLISHED', 'ACTIVE'].includes(normalized)) {
    return 'success';
  }

  if (['DRAFT', 'PENDING', 'IN_REVIEW'].includes(normalized)) {
    return 'warning';
  }

  if (['DEPRECATED', 'REJECTED', 'DISABLED', 'ARCHIVED'].includes(normalized)) {
    return 'danger';
  }

  return '';
}

function formatLabel(value: string) {
  return value.replace(/_/g, ' ');
}

function MetricIcon({ children }: { children: React.ReactNode }) {
  return <span className="library-stat-icon">{children}</span>;
}

function TemplateIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        d="M7 4.75h10A2.25 2.25 0 0 1 19.25 7v10A2.25 2.25 0 0 1 17 19.25H7A2.25 2.25 0 0 1 4.75 17V7A2.25 2.25 0 0 1 7 4.75Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M8 9h8M8 12h8M8 15h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FlowIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <circle cx="7" cy="7" r="2.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="17" cy="7" r="2.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="17" r="2.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8.8 8.3 10.6 10M15.2 8.3 13.4 10M12 14.75v-2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M9 15 15 9M10.75 8.75H15.25V13.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="library-empty">
      <div className="library-empty-icon">{icon}</div>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

export default function LibraryPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [flows, setFlows] = useState<Flow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([apiRequest<Template[]>('/library/templates'), apiRequest<Flow[]>('/library/flows')])
      .then(([templatesPayload, flowsPayload]) => {
        setTemplates(templatesPayload);
        setFlows(flowsPayload);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Falha ao carregar biblioteca'));
  }, []);

  const templatesWithFlow = templates.filter((template) => template.hasFlowButton).length;
  const publishedFlows = flows.filter((flow) => flow.status.trim().toUpperCase() === 'PUBLISHED').length;
  const previewableFlows = flows.filter((flow) => flow.previewUrl).length;
  const flowsWithPayload = flows.filter((flow) => flow.completionPayloadDefinitions?.length).length;

  return (
    <AppShell title="Biblioteca Meta">
      <div className="library-page">
        {error ? <div className="notice error">{error}</div> : null}

        <div className="library-overview">
          <div className="library-stat">
            <div className="library-stat-head">
              <div>
                <h3>Templates</h3>
                <p>Total aprovado em cache local</p>
              </div>
              <MetricIcon>
                <TemplateIcon />
              </MetricIcon>
            </div>
            <strong>{templates.length}</strong>
          </div>

          <div className="library-stat">
            <div className="library-stat-head">
              <div>
                <h3>Com FLOW</h3>
                <p>Templates com botão operacional</p>
              </div>
              <MetricIcon>
                <FlowIcon />
              </MetricIcon>
            </div>
            <strong>{templatesWithFlow}</strong>
          </div>

          <div className="library-stat">
            <div className="library-stat-head">
              <div>
                <h3>Flows publicados</h3>
                <p>Prontos para associação direta</p>
              </div>
              <MetricIcon>
                <FlowIcon />
              </MetricIcon>
            </div>
            <strong>{publishedFlows}</strong>
          </div>

          <div className="library-stat">
            <div className="library-stat-head">
              <div>
                <h3>Payload final</h3>
                <p>Flows com mapeamento detectado</p>
              </div>
              <MetricIcon>
                <LinkIcon />
              </MetricIcon>
            </div>
            <strong>{flowsWithPayload}</strong>
          </div>
        </div>

        <div className="grid two library-grid">
          <SectionCard title="Templates aprovados" description="Templates sincronizados localmente para operação.">
            <div className="library-section-head">
              <div className="badge-row">
                <span className="tag">{templates.length} sincronizados</span>
                <span className="tag success">{templatesWithFlow} com FLOW</span>
              </div>
            </div>

            <div className="library-list">
              {templates.length ? (
                templates.map((template) => (
                  <div key={template.id} className="library-item">
                    <div className="library-item-top">
                      <div className="library-item-title">
                        <span className="library-item-icon">
                          <TemplateIcon />
                        </span>
                        <div>
                          <strong>{template.name}</strong>
                          <p className="library-item-subtitle">Template pronto para uso operacional.</p>
                        </div>
                      </div>

                      <div className="badge-row">
                        <span className={`tag ${getStatusTone(template.status)}`}>{formatLabel(template.status)}</span>
                        {template.hasFlowButton ? <span className="tag success">Com FLOW</span> : <span className="tag">Sem FLOW</span>}
                      </div>
                    </div>

                    <div className="badge-row">
                      <span className="tag">{template.languageCode.replace('_', '-')}</span>
                      <span className="tag">{formatLabel(template.category)}</span>
                    </div>

                    <div className="library-meta">
                      <span className="library-meta-label">Variáveis</span>
                      <div className="library-variable-list">
                        {template.variableDescriptors.length ? (
                          template.variableDescriptors.map((item) => (
                            <span key={item.label} className="tag">
                              {item.label}
                            </span>
                          ))
                        ) : (
                          <span className="tag">Sem placeholders</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <EmptyState
                  icon={<TemplateIcon />}
                  title="Nenhum template sincronizado"
                  description="Sincronize a integração para popular a biblioteca local."
                />
              )}
            </div>
          </SectionCard>

          <SectionCard title="Flows" description="Flows disponíveis para consulta e associação operacional.">
            <div className="library-section-head">
              <div className="badge-row">
                <span className="tag">{flows.length} sincronizados</span>
                <span className="tag success">{publishedFlows} publicados</span>
                <span className="tag">{previewableFlows} com preview</span>
              </div>
            </div>

            <div className="library-list">
              {flows.length ? (
                flows.map((flow) => (
                  <div key={flow.id} className="library-item">
                    <div className="library-item-top">
                      <div className="library-item-title">
                        <span className="library-item-icon flow">
                          <FlowIcon />
                        </span>
                        <div>
                          <strong>{flow.name}</strong>
                          <p className="library-item-subtitle">Flow disponível para consulta e associação.</p>
                        </div>
                      </div>

                      <span className={`tag ${getStatusTone(flow.status)}`}>{formatLabel(flow.status)}</span>
                    </div>

                    <div className="badge-row">
                      {flow.categories.length ? (
                        flow.categories.map((category) => (
                          <span key={category} className="tag">
                            {formatLabel(category)}
                          </span>
                        ))
                      ) : (
                        <span className="tag">Sem categoria</span>
                      )}

                      {flow.previewUrl ? (
                        <a className="tag success library-link" href={flow.previewUrl} target="_blank" rel="noreferrer">
                          <LinkIcon />
                          Preview
                        </a>
                      ) : (
                        <span className="tag warning">Sem preview</span>
                      )}
                    </div>

                    {flow.completionPayloadDefinitions?.length ? (
                      <div className="library-payload-box">
                        <div className="badge-row">
                          <span className="tag success">Payload final detectado</span>
                        </div>

                        <div className="library-payload-list">
                          {flow.completionPayloadDefinitions.map((definition) => (
                            <div
                              key={`${flow.id}:${definition.screenId}:${definition.actionName}`}
                              className="library-payload-item"
                            >
                              <div className="library-payload-header">
                                <strong>
                                  Tela {definition.screenId}
                                  {definition.formName ? ` / ${definition.formName}` : ''}
                                </strong>
                                <span className="tag">{definition.actionName}</span>
                              </div>

                              <div className="library-payload-fields">
                                {definition.payloadFields.map((field) => (
                                  <span key={`${definition.screenId}:${field.key}`} className="tag">
                                    {field.sourceType === 'form'
                                      ? `${field.key} <= form.${field.sourceField}`
                                      : field.sourceType === 'expression'
                                        ? `${field.key} <= ${field.expression}`
                                        : `${field.key} = ${field.staticValue ?? ''}`}
                                  </span>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="library-inline-note">Payload final não detectado automaticamente.</div>
                    )}
                  </div>
                ))
              ) : (
                <EmptyState
                  icon={<FlowIcon />}
                  title="Nenhum flow sincronizado"
                  description="Sincronize os flows da integração para consultar previews e categorias."
                />
              )}
            </div>
          </SectionCard>
        </div>
      </div>
    </AppShell>
  );
}
