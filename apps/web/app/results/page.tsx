'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell, useShell } from '../../components/app-shell';
import { BadgeText, EmptyState, ErrorBanner, Kpi, KpiSkeleton, SkeletonRows, usePagedRows } from '../../components/ui';
import { apiDownload, apiRequest } from '../../lib/api';
import { BadgeClass } from '../../lib/badges';
import { fmtDateTime, fmtInt } from '../../lib/format';

interface DeliveryOverview {
  totalTrackedMessages: number;
  totalAcceptedMessages: number;
  totalSentMessages: number;
  totalDeliveredMessages: number;
  totalReadMessages: number;
  totalFailedMessages: number;
  totalPendingMessages: number;
}

interface TimelinePoint {
  day: string;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
}

interface CampaignRanking {
  campaignId: string;
  campaignName: string;
  total: number;
  delivered: number;
  read: number;
  failed: number;
}

interface ErrorRow {
  label: string;
  count: number;
  percentage: number;
}

interface SurveyDistributionItem {
  value: string;
  count: number;
  percentage: number;
  /** Rótulo legível da opção (ex.: "Muito satisfeito"); ausente quando o flow não declara escala. */
  label?: string | null;
}

interface SurveySegment {
  label: string;
  count: number;
  percentage?: number;
  tone?: 'success' | 'warning' | 'danger' | 'neutral';
}

interface SurveyMetric {
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
  /** 'observed' = a faixa da escala não veio do flow, foi deduzida das respostas. */
  scaleSource?: 'declared' | 'observed' | null;
  /**
   * Orientação da escala lida nos rótulos: 'ascending' maior = melhor,
   * 'descending' menor = melhor, 'assumed' não foi possível determinar.
   */
  scaleOrientation?: 'ascending' | 'descending' | 'assumed' | null;
  distribution: SurveyDistributionItem[];
  segments: SurveySegment[];
}

interface Summary {
  totalFlowResponses: number;
  deliveryOverview: DeliveryOverview;
  deliveryTimeline: TimelinePoint[];
  topDeliveryCampaigns: CampaignRanking[];
  errorBreakdown: ErrorRow[];
  surveyMetrics?: SurveyMetric[];
}

interface FlowResponse {
  id: string;
  completedAt: string;
  campaignName: string | null;
  contactName: string | null;
  contactPhone: string | null;
  flowName: string | null;
  templateName: string | null;
  responsePayload: Record<string, unknown>;
}

const SERIES: Array<{ key: keyof Omit<TimelinePoint, 'day'>; label: string; color: string }> = [
  { key: 'sent', label: 'Enviadas', color: 'var(--info)' },
  { key: 'delivered', label: 'Entregues', color: 'var(--success)' },
  { key: 'read', label: 'Lidas', color: 'var(--collos-cinza)' },
  { key: 'failed', label: 'Falhas', color: 'var(--danger)' },
];

export default function ResultsPage() {
  return (
    <AppShell title="Resultados">
      <ResultsContent />
    </AppShell>
  );
}

function ResultsContent() {
  const [tab, setTab] = useState<'summary' | 'flow' | 'tables' | 'events'>('summary');

  return (
    <>
      <div className="op-head">
        <div className="op-head-titles">
          <h1 className="op-title">Resultados</h1>
          <p className="op-sub">Entrega de mensagens e respostas de flow.</p>
        </div>
      </div>

      <div className="tabs-list page-tabs">
        <button className={`tab-trigger${tab === 'summary' ? ' active' : ''}`} onClick={() => setTab('summary')}>
          Resumo
        </button>
        <button className={`tab-trigger${tab === 'flow' ? ' active' : ''}`} onClick={() => setTab('flow')}>
          Respostas de flow
        </button>
        <button className={`tab-trigger${tab === 'tables' ? ' active' : ''}`} onClick={() => setTab('tables')}>
          Tabelas por campanha
        </button>
        <button className={`tab-trigger${tab === 'events' ? ' active' : ''}`} onClick={() => setTab('events')}>
          Eventos
        </button>
      </div>

      {tab === 'summary' ? <SummaryTab /> : null}
      {tab === 'flow' ? <FlowTab /> : null}
      {tab === 'tables' ? <CampaignTablesTab /> : null}
      {tab === 'events' ? (
        <div className="tbl-wrap">
          <EmptyState title="Sem dados no período" desc="O feed de eventos por mensagem será exibido aqui." />
        </div>
      ) : null}
    </>
  );
}

function SummaryTab() {
  const { scopeClientId } = useShell();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    void apiRequest<Summary>(`/results/summary${scopeClientId ? `?clientId=${encodeURIComponent(scopeClientId)}` : ''}`)
      .then((data) => {
        setSummary(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar resultados.');
        setLoading(false);
      });
  }, [scopeClientId]);

  useEffect(() => {
    load();
  }, [load]);

  const o = summary?.deliveryOverview;
  const timeline = summary?.deliveryTimeline ?? [];
  const maxTotal = Math.max(
    1,
    ...timeline.map((p) => p.sent + p.delivered + p.read + p.failed),
  );

  return (
    <>
      {error ? <ErrorBanner message={error} onRetry={load} /> : null}

      <div className="kpi-grid k6 block">
        {loading ? (
          <KpiSkeleton count={6} />
        ) : (
          <>
            <Kpi label="Aceitas" value={fmtInt(o?.totalAcceptedMessages)} />
            <Kpi label="Enviadas" value={fmtInt(o?.totalSentMessages)} />
            <Kpi label="Entregues" value={fmtInt(o?.totalDeliveredMessages)} />
            <Kpi label="Lidas" value={fmtInt(o?.totalReadMessages)} />
            <Kpi label="Falhas" value={fmtInt(o?.totalFailedMessages)} />
            <Kpi label="Respostas de flow" value={fmtInt(summary?.totalFlowResponses)} />
          </>
        )}
      </div>

      <SurveySection loading={loading} metrics={summary?.surveyMetrics ?? []} />

      <div className="block">
        <div className="block-head">
          <span className="block-title">Volume por dia</span>
          <div className="legend">
            {SERIES.map((s) => (
              <span key={s.key} className="legend-item">
                <span className="legend-dot" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        </div>
        <div className="panel">
          {timeline.length === 0 ? (
            <EmptyState title="Sem dados no período" />
          ) : (
            <div className="chart">
              {timeline.map((point) => (
                <div key={point.day} className="chart-col">
                  <div className="chart-stack" style={{ height: 176 }}>
                    {SERIES.map((s) => {
                      const value = point[s.key];
                      const height = (value / maxTotal) * 176;
                      return height > 0 ? (
                        <span key={s.key} style={{ height, background: s.color }} title={`${s.label}: ${value}`} />
                      ) : null;
                    })}
                  </div>
                  <span className="chart-x">{point.day.slice(5)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="dash-cols">
        <div className="block">
          <div className="block-head">
            <span className="block-title">Ranking por campanha</span>
          </div>
          <div className="tbl-wrap">
            <table className="tbl dense">
              <thead>
                <tr>
                  <th>Campanha</th>
                  <th className="num">Total</th>
                  <th className="num">Entregues</th>
                  <th className="num">Lidas</th>
                  <th className="num">Falhas</th>
                  <th></th>
                </tr>
              </thead>
              {loading ? (
                <SkeletonRows rows={4} cols={6} />
              ) : (
                <tbody>
                  {(summary?.topDeliveryCampaigns ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={6}>
                        <EmptyState title="Sem dados no período" />
                      </td>
                    </tr>
                  ) : (
                    summary?.topDeliveryCampaigns.map((row) => (
                      <tr key={row.campaignId}>
                        <td className="cell-strong">{row.campaignName}</td>
                        <td className="num">{fmtInt(row.total)}</td>
                        <td className="num">{fmtInt(row.delivered)}</td>
                        <td className="num">{fmtInt(row.read)}</td>
                        <td className="num">{fmtInt(row.failed)}</td>
                        <td>
                          <button
                            className="btn tertiary sm"
                            onClick={() => {
                              const qs = scopeClientId
                                ? `?clientId=${encodeURIComponent(scopeClientId)}`
                                : '';
                              void apiDownload(
                                `/campaigns/${row.campaignId}/export.csv${qs}`,
                                `campanha-${row.campaignId}.csv`,
                              ).catch(() => undefined);
                            }}
                          >
                            Exportar
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              )}
            </table>
          </div>
        </div>

        <div className="block">
          <div className="block-head">
            <span className="block-title">Ranking por erro</span>
          </div>
          <div className="tbl-wrap">
            <table className="tbl dense">
              <thead>
                <tr>
                  <th>Erro</th>
                  <th className="num">Ocorrências</th>
                  <th className="num">%</th>
                </tr>
              </thead>
              {loading ? (
                <SkeletonRows rows={4} cols={3} />
              ) : (
                <tbody>
                  {(summary?.errorBreakdown ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={3}>
                        <EmptyState title="Sem falhas no período" />
                      </td>
                    </tr>
                  ) : (
                    summary?.errorBreakdown.map((row) => (
                      <tr key={row.label}>
                        <td className="cell-sub">{row.label}</td>
                        <td className="num">{fmtInt(row.count)}</td>
                        <td className="num">{row.percentage}%</td>
                      </tr>
                    ))
                  )}
                </tbody>
              )}
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

const decimalFormatter = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

const fmtDecimal = (value: number | null | undefined): string =>
  value === null || value === undefined || Number.isNaN(value) ? '—' : decimalFormatter.format(value);

// CSAT chega como percentual (top-2-box); NPS é um índice de -100 a 100.
const fmtSurveyScore = (metric: SurveyMetric): string =>
  metric.metricType === 'csat' ? `${fmtDecimal(metric.score)}%` : fmtDecimal(metric.score);

// Siglas de pesquisa que devem sair em caixa alta no título do card.
const SURVEY_ACRONYMS = new Set(['nps', 'csat']);

const humanizeFieldKey = (key: string): string => {
  const tokens = key.split(/[_.\-\s]+/).filter(Boolean);
  if (tokens.length === 0) {
    return key;
  }

  const words = tokens.map((token) =>
    SURVEY_ACRONYMS.has(token.toLowerCase()) ? token.toUpperCase() : token,
  );

  // Campo sem sigla mantém o comportamento anterior: só a primeira letra sobe.
  if (!SURVEY_ACRONYMS.has(tokens[0].toLowerCase())) {
    words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  }

  return words.join(' ');
};

// Frase que o backend anexa ao `scoreHint` quando a orientação é assumida
// (results.service.ts, buildCsatScoreHint). Quando o card mostra o aviso de
// orientação — que já traz badge e ação —, ela sai do hint para não repetir.
const ASSUMED_ORIENTATION_SENTENCE =
  /\s*Orienta[çc][ãa]o n[ãa]o identificada pelos r[óo]tulos:\s*assumido maior = melhor\.?/i;

const surveyScoreHint = (metric: SurveyMetric, hasOrientationNotice: boolean): string => {
  const hint = metric.scoreHint ?? '';
  return hasOrientationNotice ? hint.replace(ASSUMED_ORIENTATION_SENTENCE, '').trim() : hint;
};

const segmentBadgeClass = (tone: SurveySegment['tone']): BadgeClass =>
  tone === 'success' || tone === 'warning' || tone === 'danger' ? tone : 'neutral';

function SurveySection({ loading, metrics }: { loading: boolean; metrics: SurveyMetric[] }) {
  const npsMetrics = metrics.filter((metric) => metric.metricType === 'nps');
  const csatMetrics = metrics.filter((metric) => metric.metricType === 'csat');

  return (
    <div className="block">
      <div className="block-head">
        <span className="block-title">Pesquisas NPS e CSAT</span>
        {!loading && metrics.length > 0 ? (
          <span className="kpi-foot">Apurado sobre as respostas de flow do período.</span>
        ) : null}
      </div>

      {loading ? (
        <div className="tbl-wrap">
          <table className="tbl dense">
            <thead>
              <tr>
                <th>Pesquisa</th>
                <th className="num">Score</th>
                <th className="num">Respostas válidas</th>
              </tr>
            </thead>
            <SkeletonRows rows={4} cols={3} />
          </table>
        </div>
      ) : metrics.length === 0 ? (
        <div className="panel">
          <EmptyState
            title="Sem respostas de pesquisa"
            desc="NPS e CSAT aparecem aqui assim que as primeiras respostas do flow chegarem."
          />
        </div>
      ) : (
        <div className="stack" style={{ gap: 16 }}>
          {npsMetrics.map((metric) => (
            <SurveyMetricCard key={metric.fieldKey} metric={metric} />
          ))}
          {csatMetrics.length > 0 ? (
            <div className="grid-3">
              {csatMetrics.map((metric) => (
                <SurveyMetricCard key={metric.fieldKey} metric={metric} />
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function SurveyNotice({ badge, text }: { badge: string; text: string }) {
  return (
    <div className="row" style={{ marginTop: 10, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
      <BadgeText label={badge} cls="warning" />
      <span className="kpi-foot" style={{ flex: 1, minWidth: 0 }}>
        {text}
      </span>
    </div>
  );
}

function SurveyMetricCard({ metric }: { metric: SurveyMetric }) {
  const maxCount = Math.max(1, ...metric.distribution.map((item) => item.count));
  // A faixa da escala não veio do flow: a ação é sincronizar.
  const observedScale = metric.scaleSource === 'observed';
  // Sem escala declarada a orientação é SEMPRE 'assumed', e nesse estado quem
  // resolve é o sync (é ele que traz os rótulos de onde sai a orientação). Avisar
  // aqui empilharia dois textos e mandaria o operador fazer a coisa errada — o
  // aviso só vale com escala declarada, quando os rótulos existem e mesmo assim
  // não deram a leitura. Aí, sim, sincronizar não resolve.
  const assumedOrientation =
    metric.scaleSource === 'declared' && metric.scaleOrientation === 'assumed';
  const invertedScale = metric.scaleOrientation === 'descending';

  return (
    <div className="panel">
      <div className="block-head">
        <div>
          <div className="panel-title">{humanizeFieldKey(metric.fieldKey)}</div>
          <div className="kpi-foot">{metric.label}</div>
        </div>
        <div className="row" style={{ gap: 6, flexShrink: 0 }}>
          {invertedScale ? <BadgeText label="Escala invertida" cls="info" /> : null}
          <BadgeText label={metric.scoreLabel} cls="neutral" />
        </div>
      </div>

      <div className="row" style={{ alignItems: 'baseline', gap: 10 }}>
        <span className="kpi-val">{fmtSurveyScore(metric)}</span>
        <span className="kpi-label">
          {metric.averageScore === null || metric.averageScore === undefined
            ? `${fmtInt(metric.validResponses)} resposta(s) válida(s)`
            : `média ${fmtDecimal(metric.averageScore)} · ${fmtInt(metric.validResponses)} resposta(s) válida(s)`}
        </span>
      </div>

      <p className="kpi-foot" style={{ marginTop: 6 }}>
        {surveyScoreHint(metric, assumedOrientation)}
      </p>
      {metric.ignoredResponses > 0 ? (
        <p className="kpi-foot">{fmtInt(metric.ignoredResponses)} resposta(s) fora da escala ignorada(s).</p>
      ) : null}

      {observedScale ? (
        <SurveyNotice
          badge="Escala inferida"
          text="A faixa da escala não veio do flow: foi deduzida das respostas recebidas. Re-sincronize o flow para o número ficar exato."
        />
      ) : null}

      {assumedOrientation ? (
        <SurveyNotice
          badge="Orientação não confirmada"
          text="Os rótulos não dizem qual ponta da escala é a melhor. O cálculo assumiu maior = melhor; se a escala for invertida, o score está trocado. Revise as opções da pergunta: sincronizar o flow não resolve."
        />
      ) : null}

      {metric.segments.length > 0 ? (
        <div className="row" style={{ marginTop: 14 }}>
          {metric.segments.map((segment) => (
            <BadgeText
              key={segment.label}
              cls={segmentBadgeClass(segment.tone)}
              label={
                segment.percentage === null || segment.percentage === undefined
                  ? `${segment.label} · ${fmtInt(segment.count)}`
                  : `${segment.label} · ${fmtInt(segment.count)} (${fmtDecimal(segment.percentage)}%)`
              }
            />
          ))}
        </div>
      ) : null}

      {metric.distribution.length > 0 ? (
        <div className="stack" style={{ marginTop: 14, gap: 8 }}>
          {metric.distribution.map((item) => (
            <div key={item.value}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'nowrap' }}>
                <span className="kpi-label" style={{ minWidth: 0 }}>
                  {item.label?.trim() ? item.label : item.value}
                </span>
                <span className="kpi-foot" style={{ flexShrink: 0 }}>
                  {fmtInt(item.count)} · {fmtDecimal(item.percentage)}%
                </span>
              </div>
              <div className="mini-bar" style={{ width: '100%', marginTop: 4 }}>
                <span style={{ width: `${(item.count / maxCount) * 100}%`, background: 'var(--accent)' }} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FlowTab() {
  const { scopeClientId } = useShell();
  const [responses, setResponses] = useState<FlowResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [flow, setFlow] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    void apiRequest<FlowResponse[]>(
      `/results/flow-responses?limit=500${scopeClientId ? `&clientId=${encodeURIComponent(scopeClientId)}` : ''}`,
    )
      .then((data) => {
        setResponses(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar respostas.');
        setLoading(false);
      });
  }, [scopeClientId]);

  useEffect(() => {
    load();
  }, [load]);

  const flows = useMemo(
    () => Array.from(new Set(responses.map((r) => r.flowName).filter(Boolean))) as string[],
    [responses],
  );

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return responses.filter((r) => {
      if (flow && r.flowName !== flow) return false;
      if (term) {
        const hay = `${r.contactName ?? ''} ${r.contactPhone ?? ''} ${r.campaignName ?? ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [responses, search, flow]);

  const { pageRows, pager } = usePagedRows(filtered, 'resposta(s)');

  return (
    <>
      {error ? <ErrorBanner message={error} onRetry={load} /> : null}

      <div className="toolbar">
        <div className="tb-search">
          <SearchIcon />
          <input placeholder="Buscar contato ou campanha" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select className="flt" value={flow} onChange={(e) => setFlow(e.target.value)}>
          <option value="">Flow</option>
          {flows.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>

      <div className="tbl-wrap">
        <table className="tbl dense">
          <thead>
            <tr>
              <th>Campanha</th>
              <th>Template</th>
              <th>Contato</th>
              <th>WhatsApp</th>
              <th>Flow</th>
              <th>Concluído em</th>
              <th className="num">Campos respondidos</th>
            </tr>
          </thead>
          {loading ? (
            <SkeletonRows rows={8} cols={7} />
          ) : (
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <EmptyState title="Sem respostas de flow" />
                  </td>
                </tr>
              ) : (
                pageRows.map((r) => (
                  <tr key={r.id}>
                    <td className="cell-sub">{r.campaignName ?? '—'}</td>
                    <td className="cell-sub">{r.templateName ?? '—'}</td>
                    <td className="cell-strong">{r.contactName ?? '—'}</td>
                    <td className="cell-mono">{r.contactPhone ?? '—'}</td>
                    <td className="cell-sub">{r.flowName ?? '—'}</td>
                    <td className="cell-mono">{fmtDateTime(r.completedAt)}</td>
                    <td className="num">{fmtInt(Object.keys(r.responsePayload ?? {}).length)}</td>
                  </tr>
                ))
              )}
            </tbody>
          )}
        </table>
        {pager}
      </div>
    </>
  );
}

type CampaignWithResponses = {
  campaignId: string;
  campaignName: string;
  totalResponses: number;
  lastResponseAt: string | null;
};

type CampaignTable = {
  campaignId: string;
  campaignName: string | null;
  flowName: string | null;
  fieldColumns: string[];
  situationSummary: Array<{ situacao: string; total: number }>;
  rows: Array<Record<string, unknown>>;
};

/**
 * Tabela crua por campanha: os campos do flow viram colunas, sem interpretar o que
 * significam. Cada disparo aparece com a situação final, então os 100% dos casos são
 * explicáveis — inclusive quem não respondeu e por quê.
 */
function CampaignTablesTab() {
  const { scopeClientId } = useShell();
  const [campaigns, setCampaigns] = useState<CampaignWithResponses[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [table, setTable] = useState<CampaignTable | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingTable, setLoadingTable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [situacao, setSituacao] = useState('');
  const [respondeu, setRespondeu] = useState('');

  const scopeQuery = scopeClientId ? `?clientId=${encodeURIComponent(scopeClientId)}` : '';

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    void apiRequest<CampaignWithResponses[]>(`/results/campaigns${scopeQuery}`)
      .then((data) => {
        setCampaigns(data);
        setSelected((current) => current || data[0]?.campaignId || '');
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar campanhas.');
        setLoading(false);
      });
  }, [scopeQuery]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!selected) {
      setTable(null);
      return;
    }
    setLoadingTable(true);
    setSituacao('');
    setRespondeu('');
    void apiRequest<CampaignTable>(`/results/campaigns/${encodeURIComponent(selected)}/table${scopeQuery}`)
      .then((data) => {
        setTable(data);
        setLoadingTable(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar a tabela.');
        setLoadingTable(false);
      });
  }, [selected, scopeQuery]);

  const situacoes = useMemo(
    () => (table?.situationSummary ?? []).map((item) => item.situacao),
    [table],
  );

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (table?.rows ?? []).filter((row) => {
      if (situacao && String(row.situacao ?? '') !== situacao) return false;
      if (respondeu && String(row.respondeu ?? '') !== respondeu) return false;
      if (term) {
        const hay = `${row.telefone ?? ''} ${row.contato ?? ''}`.toLowerCase();
        if (!hay.includes(term)) return false;
      }
      return true;
    });
  }, [table, search, situacao, respondeu]);

  const { pageRows, pager } = usePagedRows(filtered, 'linha(s)');
  const columns = table?.fieldColumns ?? [];
  const totalCols = 6 + columns.length;

  return (
    <>
      {error ? <ErrorBanner message={error} onRetry={load} /> : null}

      <div className="toolbar">
        <select className="flt" value={selected} onChange={(e) => setSelected(e.target.value)}>
          {campaigns.length === 0 ? <option value="">Nenhuma campanha com respostas</option> : null}
          {campaigns.map((campaign) => (
            <option key={campaign.campaignId} value={campaign.campaignId}>
              {campaign.campaignName} ({campaign.totalResponses})
            </option>
          ))}
        </select>
        <div className="tb-search">
          <SearchIcon />
          <input
            placeholder="Buscar telefone ou contato"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select className="flt" value={respondeu} onChange={(e) => setRespondeu(e.target.value)}>
          <option value="">Respondeu</option>
          <option value="sim">Respondeu: Sim</option>
          <option value="nao">Respondeu: Não</option>
        </select>
        <select className="flt" value={situacao} onChange={(e) => setSituacao(e.target.value)}>
          <option value="">Situação</option>
          {situacoes.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        {selected ? (
          <button
            type="button"
            className="btn secondary sm"
            onClick={() => {
              void apiDownload(
                `/results/campaigns/${encodeURIComponent(selected)}/table.csv${scopeQuery}`,
                `respostas-${selected}.csv`,
              ).catch(() => undefined);
            }}
          >
            Exportar CSV
          </button>
        ) : null}
      </div>

      {table && table.situationSummary.length > 0 ? (
        <div className="kpi-grid k6 block">
          {table.situationSummary.map((item) => (
            <Kpi key={item.situacao} label={item.situacao} value={fmtInt(item.total)} />
          ))}
        </div>
      ) : null}

      <div className="tbl-wrap">
        <table className="tbl dense">
          <thead>
            <tr>
              <th>Telefone</th>
              <th>Tipo</th>
              <th>Situação</th>
              <th>Código Meta</th>
              <th>Respondeu</th>
              <th>Respondido em</th>
              {columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          {loading || loadingTable ? (
            <SkeletonRows rows={8} cols={totalCols} />
          ) : (
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={totalCols}>
                    <EmptyState title="Sem linhas para esta campanha" />
                  </td>
                </tr>
              ) : (
                pageRows.map((row, index) => (
                  <tr key={`${String(row.telefone)}-${index}`}>
                    <td className="cell-mono">{String(row.telefone ?? '—')}</td>
                    <td className="cell-sub">{String(row.tipo ?? '—')}</td>
                    <td className="cell-sub">{String(row.situacao ?? '—')}</td>
                    <td className="cell-mono">{String(row.codigoMeta ?? '') || '—'}</td>
                    <td className="cell-strong">{String(row.respondeu ?? '') === 'sim' ? 'Sim' : 'Não'}</td>
                    <td className="cell-mono">
                      {row.respondidoEm ? fmtDateTime(String(row.respondidoEm)) : '—'}
                    </td>
                    {columns.map((column) => (
                      <td key={column} className="cell-sub">
                        {String(row[column] ?? '') || '—'}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          )}
        </table>
        {pager}
      </div>
    </>
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
