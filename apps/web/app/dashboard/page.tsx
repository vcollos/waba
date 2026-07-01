'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell, useShell } from '../../components/app-shell';
import { Badge, EmptyState, ErrorBanner, Kpi, KpiSkeleton, SkeletonRows } from '../../components/ui';
import { apiRequest } from '../../lib/api';
import { CAMPAIGN_STATUS, badgeFor } from '../../lib/badges';
import { fmtBRL, fmtDateTime, fmtInt } from '../../lib/format';

interface CampaignRow {
  id: string;
  clientId: string | null;
  clientName: string | null;
  name: string;
  status: string;
  total: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  createdAt: string;
}

interface ClientVolumeRow {
  clientId: string;
  clientName: string | null;
  sent: number;
  delivered: number;
  failed: number;
  estimatedAmount: number;
}

interface DashboardSummary {
  scope: 'collos' | 'client';
  clientId: string | null;
  kpis: {
    activeClients: number;
    activeIntegrations: number;
    campaigns: number;
    total: number;
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    flowResponses: number;
    estimatedAmount: number;
  };
  recentCampaigns: CampaignRow[];
  topClients: ClientVolumeRow[];
}

export default function DashboardPage() {
  return (
    <AppShell title="Dashboard">
      <DashboardContent />
    </AppShell>
  );
}

function DashboardContent() {
  const { scopeClientId } = useShell();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const query = scopeClientId ? `?clientId=${encodeURIComponent(scopeClientId)}` : '';
    void apiRequest<DashboardSummary>(`/dashboard/summary${query}`)
      .then((data) => {
        setSummary(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar indicadores.');
        setLoading(false);
      });
  }, [scopeClientId]);

  useEffect(() => {
    load();
  }, [load]);

  const collos = summary?.scope === 'collos';

  return (
    <>
      <div className="op-head">
        <div className="op-head-titles">
          <h1 className="op-title">Dashboard</h1>
          <p className="op-sub">
            {collos
              ? 'Visão consolidada da operação Collos e dos clientes.'
              : 'Indicadores das suas campanhas no período.'}
          </p>
        </div>
      </div>

      {error ? <ErrorBanner message="Falha ao carregar indicadores." onRetry={load} /> : null}

      <div className={`kpi-grid ${collos ? '' : 'k6'} block`}>
        {loading ? (
          <KpiSkeleton count={collos ? 8 : 6} />
        ) : collos ? (
          <>
            <Kpi label="Clientes ativos" value={fmtInt(summary?.kpis.activeClients)} />
            <Kpi label="Integrações ativas" value={fmtInt(summary?.kpis.activeIntegrations)} />
            <Kpi label="Campanhas no período" value={fmtInt(summary?.kpis.campaigns)} />
            <Kpi label="Mensagens enviadas" value={fmtInt(summary?.kpis.sent)} />
            <Kpi label="Entregues" value={fmtInt(summary?.kpis.delivered)} />
            <Kpi label="Lidas" value={fmtInt(summary?.kpis.read)} />
            <Kpi label="Com falha" value={fmtInt(summary?.kpis.failed)} />
            <Kpi label="Valor estimado" value={fmtBRL(summary?.kpis.estimatedAmount)} />
          </>
        ) : (
          <>
            <Kpi label="Campanhas no período" value={fmtInt(summary?.kpis.campaigns)} />
            <Kpi label="Enviadas" value={fmtInt(summary?.kpis.sent)} />
            <Kpi label="Entregues" value={fmtInt(summary?.kpis.delivered)} />
            <Kpi label="Lidas" value={fmtInt(summary?.kpis.read)} />
            <Kpi label="Falhas" value={fmtInt(summary?.kpis.failed)} />
            <Kpi label="Respostas de flow" value={fmtInt(summary?.kpis.flowResponses)} />
          </>
        )}
      </div>

      <div className={collos ? 'dash-cols' : ''}>
        <RecentCampaigns
          loading={loading}
          collos={!!collos}
          rows={summary?.recentCampaigns ?? []}
        />
        {collos ? <TopClients loading={loading} rows={summary?.topClients ?? []} /> : null}
      </div>
    </>
  );
}

function RecentCampaigns({
  loading,
  collos,
  rows,
}: {
  loading: boolean;
  collos: boolean;
  rows: CampaignRow[];
}) {
  return (
    <div className="block">
      <div className="block-head">
        <span className="block-title">Campanhas recentes</span>
      </div>
      <div className="tbl-wrap">
        <table className="tbl dense">
          <thead>
            <tr>
              {collos ? <th>Cliente</th> : null}
              <th>Campanha</th>
              <th>Status</th>
              <th className="num">Total</th>
              <th className="num">Entregues</th>
              <th className="num">Lidas</th>
              <th className="num">Falhas</th>
              <th>Criada em</th>
            </tr>
          </thead>
          {loading ? (
            <SkeletonRows rows={5} cols={collos ? 8 : 7} />
          ) : (
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={collos ? 8 : 7}>
                    <EmptyState title="Sem campanhas no período" />
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id}>
                    {collos ? <td className="cell-sub">{row.clientName ?? '—'}</td> : null}
                    <td className="cell-strong">{row.name}</td>
                    <td>
                      <Badge def={badgeFor(CAMPAIGN_STATUS, row.status)} />
                    </td>
                    <td className="num">{fmtInt(row.total)}</td>
                    <td className="num">{fmtInt(row.delivered)}</td>
                    <td className="num">{fmtInt(row.read)}</td>
                    <td className="num">{fmtInt(row.failed)}</td>
                    <td className="cell-mono">{fmtDateTime(row.createdAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          )}
        </table>
      </div>
    </div>
  );
}

function TopClients({ loading, rows }: { loading: boolean; rows: ClientVolumeRow[] }) {
  return (
    <div className="block">
      <div className="block-head">
        <span className="block-title">Clientes com maior volume</span>
      </div>
      <div className="tbl-wrap">
        <table className="tbl dense">
          <thead>
            <tr>
              <th>Cliente</th>
              <th className="num">Enviadas</th>
              <th className="num">Entregues</th>
              <th className="num">Falhas</th>
              <th className="num">Valor estimado</th>
            </tr>
          </thead>
          {loading ? (
            <SkeletonRows rows={4} cols={5} />
          ) : (
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <EmptyState title="Sem dados no período" />
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.clientId}>
                    <td className="cell-strong">{row.clientName ?? '—'}</td>
                    <td className="num">{fmtInt(row.sent)}</td>
                    <td className="num">{fmtInt(row.delivered)}</td>
                    <td className="num">{fmtInt(row.failed)}</td>
                    <td className="num">{fmtBRL(row.estimatedAmount)}</td>
                  </tr>
                ))
              )}
            </tbody>
          )}
        </table>
      </div>
    </div>
  );
}
