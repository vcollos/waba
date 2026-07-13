'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '../../components/app-shell';
import { EmptyState, ErrorBanner, Kpi, KpiSkeleton, SkeletonRows } from '../../components/ui';
import { apiRequest } from '../../lib/api';
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

interface Summary {
  totalFlowResponses: number;
  deliveryOverview: DeliveryOverview;
  deliveryTimeline: TimelinePoint[];
  topDeliveryCampaigns: CampaignRanking[];
  errorBreakdown: ErrorRow[];
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
  { key: 'read', label: 'Lidas', color: 'var(--uni-vinho-medio)' },
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
  const [tab, setTab] = useState<'summary' | 'flow' | 'events'>('summary');

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
        <button className={`tab-trigger${tab === 'events' ? ' active' : ''}`} onClick={() => setTab('events')}>
          Eventos
        </button>
      </div>

      {tab === 'summary' ? <SummaryTab /> : null}
      {tab === 'flow' ? <FlowTab /> : null}
      {tab === 'events' ? (
        <div className="tbl-wrap">
          <EmptyState title="Sem dados no período" desc="O feed de eventos por mensagem será exibido aqui." />
        </div>
      ) : null}
    </>
  );
}

function SummaryTab() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    void apiRequest<Summary>('/results/summary')
      .then((data) => {
        setSummary(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar resultados.');
        setLoading(false);
      });
  }, []);

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
                </tr>
              </thead>
              {loading ? (
                <SkeletonRows rows={4} cols={5} />
              ) : (
                <tbody>
                  {(summary?.topDeliveryCampaigns ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={5}>
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

function FlowTab() {
  const [responses, setResponses] = useState<FlowResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [flow, setFlow] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    void apiRequest<FlowResponse[]>('/results/flow-responses?limit=500')
      .then((data) => {
        setResponses(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar respostas.');
        setLoading(false);
      });
  }, []);

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
                filtered.map((r) => (
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
