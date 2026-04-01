'use client';

import { useEffect, useRef, useState } from 'react';
import { AppShell } from '../../components/app-shell';
import { SectionCard } from '../../components/section-card';
import { apiRequest } from '../../lib/api';

interface ResultSummary {
  totalFlowResponses: number;
  deliveryOverview: {
    totalTrackedMessages: number;
    totalProcessedMessages: number;
    totalAcceptedMessages: number;
    totalSentMessages: number;
    totalDeliveredMessages: number;
    totalReadMessages: number;
    totalFailedMessages: number;
    totalPendingMessages: number;
    successRate: number;
    readRate: number;
    failureRate: number;
  };
  statusDistribution: Array<{
    status: string;
    label: string;
    count: number;
    percentage: number;
    tone: 'neutral' | 'success' | 'danger' | 'warning';
  }>;
  deliveryTimeline: Array<{
    day: string;
    accepted: number;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
  }>;
  topDeliveryCampaigns: Array<{
    campaignId: string;
    campaignName: string;
    status: string;
    total: number;
    pending: number;
    processed: number;
    delivered: number;
    read: number;
    failed: number;
    successRate: number;
    readRate: number;
    failureRate: number;
  }>;
  errorBreakdown: Array<{ label: string; count: number; percentage: number }>;
  byFlow: Array<{ flowName: string; count: number; percentage: number }>;
  byCampaign: Array<{ campaignName: string; count: number; percentage: number }>;
  byDay: Array<{ day: string; count: number }>;
  fieldCoverage: Array<{ fieldKey: string; count: number; percentage: number }>;
  categoricalDistributions: Array<{
    fieldKey: string;
    totalResponses: number;
    distinctValues: number;
    values: Array<{ value: string; count: number }>;
  }>;
  surveyMetrics: Array<{
    fieldKey: string;
    metricType: 'nps' | 'csat';
    label: string;
    totalResponses: number;
    validResponses: number;
    ignoredResponses: number;
    score: number;
    averageScore: number | null;
    scoreLabel: string;
    scoreHint: string;
    distribution: Array<{ value: string; count: number; percentage: number }>;
    segments: Array<{
      label: string;
      count: number;
      percentage: number;
      tone: 'success' | 'warning' | 'danger';
    }>;
  }>;
}

interface FlowResponse {
  id: string;
  campaignName?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  flowName?: string | null;
  templateName?: string | null;
  completedAt: string;
  responsePayload: Record<string, unknown>;
  detectedPayloadDefinitions?: Array<{
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
  }>;
}

export default function ResultsPage() {
  const [summary, setSummary] = useState<ResultSummary | null>(null);
  const [responses, setResponses] = useState<FlowResponse[]>([]);
  const [query, setQuery] = useState('');
  const [flowFilter, setFlowFilter] = useState('all');
  const [rowLimit, setRowLimit] = useState('100');
  const [error, setError] = useState<string | null>(null);
  const summaryInFlightRef = useRef(false);
  const responsesInFlightRef = useRef(false);

  const loadSummary = async () => {
    if (summaryInFlightRef.current) {
      return;
    }

    summaryInFlightRef.current = true;
    try {
      const payload = await apiRequest<ResultSummary>('/results/summary');
      setSummary(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar resultados');
    } finally {
      summaryInFlightRef.current = false;
    }
  };

  const loadResponses = async () => {
    if (responsesInFlightRef.current) {
      return;
    }

    responsesInFlightRef.current = true;
    try {
      const payload = await apiRequest<FlowResponse[]>('/results/flow-responses?limit=500');
      setResponses(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar respostas');
    } finally {
      responsesInFlightRef.current = false;
    }
  };

  useEffect(() => {
    void loadSummary();
    void loadResponses();
  }, []);

  useEffect(() => {
    const summaryTimer = window.setInterval(() => {
      void loadSummary();
    }, 15000);

    return () => {
      window.clearInterval(summaryTimer);
    };
  }, []);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredResponses = responses.filter((response) => {
    if (flowFilter !== 'all' && (response.flowName ?? 'Flow não identificado') !== flowFilter) {
      return false;
    }

    if (!normalizedQuery) {
      return true;
    }

    const searchable = [
      response.flowName,
      response.campaignName,
      response.contactName,
      response.contactPhone,
      JSON.stringify(response.responsePayload),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return searchable.includes(normalizedQuery);
  });

  const visibleResponses = filteredResponses.slice(0, Number(rowLimit));
  const flowOptions = summary?.byFlow.map((item) => item.flowName) ?? [];

  return (
    <AppShell title="Resultados de Flows">
      {error ? <div className="notice error">{error}</div> : null}

      <SectionCard
        title="Operação de envio"
        description="Leitura acumulada do que foi aceito, enviado, entregue, lido e falhou no ambiente."
      >
        <div className="grid four">
          <div className="metric">
            <h3>Mensagens rastreadas</h3>
            <strong>{summary?.deliveryOverview.totalTrackedMessages ?? 0}</strong>
            <p className="muted">Total materializado nas campanhas.</p>
          </div>
          <div className="metric">
            <h3>Processadas</h3>
            <strong>{summary?.deliveryOverview.totalProcessedMessages ?? 0}</strong>
            <p className="muted">Já saíram da fila ou falharam.</p>
          </div>
          <div className="metric">
            <h3>Entregues</h3>
            <strong>{summary?.deliveryOverview.totalDeliveredMessages ?? 0}</strong>
            <p className="muted">Com evento de entrega registrado.</p>
          </div>
          <div className="metric">
            <h3>Falhas</h3>
            <strong>{summary?.deliveryOverview.totalFailedMessages ?? 0}</strong>
            <p className="muted">Mensagens atualmente falhadas.</p>
          </div>
        </div>

        <div className="grid two top-gap">
          <div className="card">
            <div className="stack">
              <div>
                <strong>Funil operacional</strong>
                <div className="muted">Leitura acumulada comparável ao acompanhamento da Meta.</div>
              </div>
              <div className="chart-list compact">
                {summary?.statusDistribution.length ? (
                  summary.statusDistribution.map((item) => (
                    <div key={item.status} className="chart-row">
                      <div className="chart-head">
                        <strong>{item.label}</strong>
                        <span className="muted">
                          {item.count} / {item.percentage}%
                        </span>
                      </div>
                      <div className="chart-track">
                        <div className={`chart-bar ${toneClass(item.tone)}`} style={{ width: `${item.percentage}%` }} />
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="muted">Sem mensagens rastreadas ainda.</div>
                )}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="stack">
              <div>
                <strong>Indicadores</strong>
                <div className="muted">Taxas calculadas sobre a base rastreada.</div>
              </div>
              <div className="grid three">
                <div className="metric compact-metric">
                  <h3>Sucesso</h3>
                  <strong>{summary?.deliveryOverview.successRate ?? 0}%</strong>
                  <p className="muted">Entregues / total.</p>
                </div>
                <div className="metric compact-metric">
                  <h3>Leitura</h3>
                  <strong>{summary?.deliveryOverview.readRate ?? 0}%</strong>
                  <p className="muted">Lidas / total.</p>
                </div>
                <div className="metric compact-metric">
                  <h3>Falha</h3>
                  <strong>{summary?.deliveryOverview.failureRate ?? 0}%</strong>
                  <p className="muted">Falhadas / total.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </SectionCard>

      <div className="grid two top-gap">
        <SectionCard
          title="Linha do tempo operacional"
          description="Série acumulada por dia das mensagens aceitas, enviadas, entregues, lidas e falhas."
        >
          <div className="chart-list">
            {summary?.deliveryTimeline.length ? (
              summary.deliveryTimeline.map((item) => (
                <div key={item.day} className="timeline-card">
                  <div className="chart-head">
                    <strong>{formatDay(item.day)}</strong>
                    <span className="muted">
                      {item.delivered} entregues / {item.read} lidas / {item.failed} falhas
                    </span>
                  </div>
                  <div className="timeline-series-grid">
                    {renderSeriesStat('Aceitas', item.accepted, maxSeries(summary.deliveryTimeline, 'accepted'), 'neutral')}
                    {renderSeriesStat('Enviadas', item.sent, maxSeries(summary.deliveryTimeline, 'sent'), 'neutral')}
                    {renderSeriesStat('Entregues', item.delivered, maxSeries(summary.deliveryTimeline, 'delivered'), 'success')}
                    {renderSeriesStat('Lidas', item.read, maxSeries(summary.deliveryTimeline, 'read'), 'success')}
                    {renderSeriesStat('Falhas', item.failed, maxSeries(summary.deliveryTimeline, 'failed'), 'danger')}
                  </div>
                </div>
              ))
            ) : (
              <div className="muted">Sem eventos operacionais suficientes ainda.</div>
            )}
          </div>
        </SectionCard>

        <SectionCard
          title="Mensagens de erro"
          description="Falhas agrupadas pela combinação código/título registrada no envio ou webhook."
        >
          <div className="chart-list">
            {summary?.errorBreakdown.length ? (
              summary.errorBreakdown.map((item) => (
                <div key={item.label} className="chart-row">
                  <div className="chart-head">
                    <strong>{item.label}</strong>
                    <span className="muted">
                      {item.count} / {item.percentage}%
                    </span>
                  </div>
                  <div className="chart-track">
                    <div className="chart-bar danger" style={{ width: `${item.percentage}%` }} />
                  </div>
                </div>
              ))
            ) : (
              <div className="muted">Nenhuma falha operacional agrupada até agora.</div>
            )}
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="Top campanhas operacionais"
        description="Campanhas com mais tráfego processado, entrega e falha neste ambiente."
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Campanha</th>
                <th>Status</th>
                <th>Total</th>
                <th>Processadas</th>
                <th>Entregues</th>
                <th>Lidas</th>
                <th>Falhas</th>
                <th>Sucesso</th>
              </tr>
            </thead>
            <tbody>
              {summary?.topDeliveryCampaigns.length ? (
                summary.topDeliveryCampaigns.map((campaign) => (
                  <tr key={campaign.campaignId}>
                    <td>{campaign.campaignName}</td>
                    <td>
                      <span className={`tag ${tagTone(campaign.status)}`}>{campaign.status}</span>
                    </td>
                    <td>{campaign.total}</td>
                    <td>{campaign.processed}</td>
                    <td>{campaign.delivered}</td>
                    <td>{campaign.read}</td>
                    <td>{campaign.failed}</td>
                    <td>{campaign.successRate}%</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8} className="muted">
                    Nenhuma campanha operacional com tráfego ainda.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <div className="grid four">
        <div className="metric">
          <h3>Respostas</h3>
          <strong>{summary?.totalFlowResponses ?? 0}</strong>
          <p className="muted">Payload bruto preservado para auditoria.</p>
        </div>
        <div className="metric">
          <h3>Flows com resposta</h3>
          <strong>{summary?.byFlow.length ?? 0}</strong>
          <p className="muted">Agrupamento imediato por Flow.</p>
        </div>
        <div className="metric">
          <h3>Campanhas com resposta</h3>
          <strong>{summary?.byCampaign.length ?? 0}</strong>
          <p className="muted">Top campanhas com respostas recebidas.</p>
        </div>
        <div className="metric">
          <h3>Campos detectados</h3>
          <strong>{summary?.fieldCoverage.length ?? 0}</strong>
          <p className="muted">Cobertura dos campos presentes nos payloads.</p>
        </div>
      </div>

      <div className="grid two top-gap">
        <SectionCard title="Distribuição por Flow" description="Volume e participação de cada Flow.">
          <div className="chart-list">
            {summary?.byFlow.length ? (
              summary.byFlow.map((item) => (
                <div key={item.flowName} className="chart-row">
                  <div className="chart-head">
                    <strong>{item.flowName}</strong>
                    <span className="muted">
                      {item.count} resposta(s) / {item.percentage}%
                    </span>
                  </div>
                  <div className="chart-track">
                    <div className="chart-bar" style={{ width: `${item.percentage}%` }} />
                  </div>
                </div>
              ))
            ) : (
              <div className="muted">Nenhuma resposta recebida ainda.</div>
            )}
          </div>
        </SectionCard>

        <SectionCard title="Top campanhas" description="Campanhas mais respondidas até agora.">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Campanha</th>
                  <th>Respostas</th>
                  <th>Participação</th>
                </tr>
              </thead>
              <tbody>
                {summary?.byCampaign.length ? (
                  summary.byCampaign.map((item) => (
                    <tr key={item.campaignName}>
                      <td>{item.campaignName}</td>
                      <td>{item.count}</td>
                      <td>{item.percentage}%</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={3} className="muted">
                      Nenhuma campanha com resposta ainda.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </div>

      <div className="grid two top-gap">
        <SectionCard title="Linha do tempo" description="Respostas por dia para leitura rápida de tração.">
          <div className="chart-list">
            {summary?.byDay.length ? (
              summary.byDay.map((item) => {
                const maxCount = Math.max(...(summary.byDay.map((day) => day.count) || [1]));
                const percentage = maxCount ? Number(((item.count / maxCount) * 100).toFixed(1)) : 0;
                return (
                  <div key={item.day} className="chart-row">
                    <div className="chart-head">
                      <strong>{formatDay(item.day)}</strong>
                      <span className="muted">{item.count} resposta(s)</span>
                    </div>
                    <div className="chart-track">
                      <div className="chart-bar secondary" style={{ width: `${percentage}%` }} />
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="muted">Sem histórico suficiente para gráfico diário.</div>
            )}
          </div>
        </SectionCard>

        <SectionCard title="Cobertura de campos" description="Quais chaves aparecem com mais frequência.">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Campo</th>
                  <th>Ocorrências</th>
                  <th>Cobertura</th>
                </tr>
              </thead>
              <tbody>
                {summary?.fieldCoverage.length ? (
                  summary.fieldCoverage.map((item) => (
                    <tr key={item.fieldKey}>
                      <td>{item.fieldKey}</td>
                      <td>{item.count}</td>
                      <td>{item.percentage}%</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={3} className="muted">
                      Sem campos detectados ainda.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="Distribuições categóricas"
        description="Campos com poucas opções distintas, úteis para NPS, CSAT e respostas fechadas."
      >
        <div className="grid two">
          {summary?.categoricalDistributions.length ? (
            summary.categoricalDistributions.map((distribution) => (
              <div key={distribution.fieldKey} className="card">
                <div className="stack">
                  <div>
                    <strong>{distribution.fieldKey}</strong>
                    <div className="muted">
                      {distribution.totalResponses} resposta(s) / {distribution.distinctValues} valor(es)
                    </div>
                  </div>
                  <div className="chart-list compact">
                    {distribution.values.map((item) => {
                      const percentage = distribution.totalResponses
                        ? Number(((item.count / distribution.totalResponses) * 100).toFixed(1))
                        : 0;
                      return (
                        <div key={`${distribution.fieldKey}:${item.value}`} className="chart-row">
                          <div className="chart-head">
                            <strong>{item.value}</strong>
                            <span className="muted">
                              {item.count} / {percentage}%
                            </span>
                          </div>
                          <div className="chart-track">
                            <div className="chart-bar" style={{ width: `${percentage}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="muted">Ainda não há campos categóricos suficientes para distribuição.</div>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="Indicadores NPS e CSAT"
        description="Cálculo de score a partir dos campos detectados no payload. NPS aplica a regra padrão e CSAT usa top-2-box da escala identificada."
      >
        <div className="grid two">
          {summary?.surveyMetrics.length ? (
            summary.surveyMetrics.map((metric) => (
              <div key={`${metric.metricType}:${metric.fieldKey}`} className="card">
                <div className="stack">
                  <div className="card-header">
                    <h3>
                      {metric.scoreLabel} · {metric.fieldKey}
                    </h3>
                    <p>{metric.scoreHint}</p>
                  </div>

                  <div className="grid four">
                    <div className="metric compact-metric">
                      <h3>Score</h3>
                      <strong>
                        {metric.metricType === 'nps' ? metric.score : `${metric.score}%`}
                      </strong>
                      <p className="muted">{metric.label}</p>
                    </div>
                    <div className="metric compact-metric">
                      <h3>Válidas</h3>
                      <strong>{metric.validResponses}</strong>
                      <p className="muted">Entram no cálculo.</p>
                    </div>
                    <div className="metric compact-metric">
                      <h3>Ignoradas</h3>
                      <strong>{metric.ignoredResponses}</strong>
                      <p className="muted">Fora da escala detectada.</p>
                    </div>
                    <div className="metric compact-metric">
                      <h3>Média</h3>
                      <strong>{metric.averageScore ?? '-'}</strong>
                      <p className="muted">Leitura auxiliar.</p>
                    </div>
                  </div>

                  <div className="grid three">
                    {metric.segments.map((segment) => (
                      <div key={`${metric.fieldKey}:${segment.label}`} className="chart-row">
                        <div className="chart-head">
                          <strong>{segment.label}</strong>
                          <span className="muted">
                            {segment.count} / {segment.percentage}%
                          </span>
                        </div>
                        <div className="chart-track">
                          <div
                            className={`chart-bar ${toneClass(segment.tone)}`}
                            style={{ width: `${segment.percentage}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="chart-list compact">
                    {metric.distribution.map((item) => (
                      <div key={`${metric.fieldKey}:${item.value}`} className="chart-row">
                        <div className="chart-head">
                          <strong>{item.value}</strong>
                          <span className="muted">
                            {item.count} / {item.percentage}%
                          </span>
                        </div>
                        <div className="chart-track">
                          <div className="chart-bar secondary" style={{ width: `${item.percentage}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="muted">Ainda não há campos `nps` ou `csat/cesat` suficientes para cálculo.</div>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="Respostas recebidas"
        description="Tabela operacional para grandes volumes, com filtro por texto, Flow e limite visível."
      >
        <div className="grid three">
          <div className="field">
            <label>Buscar</label>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="flow, campanha, contato, payload..."
            />
          </div>
          <div className="field">
            <label>Flow</label>
            <select value={flowFilter} onChange={(event) => setFlowFilter(event.target.value)}>
              <option value="all">Todos</option>
              {flowOptions.map((flowName) => (
                <option key={flowName} value={flowName}>
                  {flowName}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Linhas visíveis</label>
            <select value={rowLimit} onChange={(event) => setRowLimit(event.target.value)}>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="250">250</option>
            </select>
          </div>
        </div>

        <div className="notice top-gap">
          Mostrando {visibleResponses.length} de {filteredResponses.length} resposta(s) filtrada(s).
        </div>

        <div className="table-wrap top-gap">
          <table>
            <thead>
              <tr>
                <th>Flow</th>
                <th>Campanha</th>
                <th>Contato</th>
                <th>Recebido em</th>
                <th>Resumo do payload</th>
                <th>Detalhes</th>
              </tr>
            </thead>
            <tbody>
              {visibleResponses.length ? (
                visibleResponses.map((response) => (
                  <tr key={response.id}>
                    <td>{response.flowName ?? 'Flow não identificado'}</td>
                    <td>{response.campaignName ?? 'Sem campanha'}</td>
                    <td>{response.contactName ?? response.contactPhone ?? 'Contato não identificado'}</td>
                    <td>{new Date(response.completedAt).toLocaleString('pt-BR')}</td>
                    <td>{summarizePayload(response.responsePayload)}</td>
                    <td>
                      <details>
                        <summary>Ver JSON</summary>
                        {response.detectedPayloadDefinitions?.length ? (
                          <div className="stack top-gap">
                            {response.detectedPayloadDefinitions.map((definition) => (
                              <div
                                key={`${response.id}:${definition.screenId}:${definition.actionName}`}
                                className="notice"
                              >
                                <div className="muted">
                                  Tela {definition.screenId}
                                  {definition.formName ? ` / formulário ${definition.formName}` : ''}
                                </div>
                                <div className="muted">
                                  {definition.payloadFields
                                    .map((field) => {
                                      if (field.sourceType === 'form') {
                                        return `${field.key} <= form.${field.sourceField}`;
                                      }
                                      if (field.sourceType === 'expression') {
                                        return `${field.key} <= ${field.expression}`;
                                      }
                                      return `${field.key} = ${field.staticValue ?? ''}`;
                                    })
                                    .join(' | ')}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        <pre className="json-block">
                          {JSON.stringify(response.responsePayload, null, 2)}
                        </pre>
                      </details>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="muted">
                    Nenhuma resposta corresponde ao filtro atual.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </AppShell>
  );
}

const summarizePayload = (payload: Record<string, unknown>): string => {
  const entries = Object.entries(payload).slice(0, 4);
  if (!entries.length) {
    return 'Payload vazio';
  }

  return entries
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(' | ');
};

const formatDay = (value: string): string => {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(date);
};

const toneClass = (tone: 'neutral' | 'success' | 'danger' | 'warning'): string => {
  if (tone === 'success') return 'success';
  if (tone === 'danger') return 'danger';
  if (tone === 'warning') return 'warning';
  return 'secondary';
};

const tagTone = (status: string): string => {
  if (['completed', 'read', 'delivered'].includes(status)) {
    return 'success';
  }
  if (['failed', 'cancelled'].includes(status)) {
    return 'danger';
  }
  if (['queued', 'sending', 'pending', 'paused'].includes(status)) {
    return 'warning';
  }
  return '';
};

const maxSeries = (
  timeline: ResultSummary['deliveryTimeline'],
  key: 'accepted' | 'sent' | 'delivered' | 'read' | 'failed',
): number => Math.max(1, ...timeline.map((item) => item[key]));

const renderSeriesStat = (
  label: string,
  value: number,
  maxValue: number,
  tone: 'neutral' | 'success' | 'danger',
) => {
  const percentage = maxValue ? Number(((value / maxValue) * 100).toFixed(1)) : 0;
  return (
    <div className="mini-series" key={label}>
      <div className="chart-head">
        <span>{label}</span>
        <span className="muted">{value}</span>
      </div>
      <div className="chart-track">
        <div className={`chart-bar ${toneClass(tone)}`} style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
};
