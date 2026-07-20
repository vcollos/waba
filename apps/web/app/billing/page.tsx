'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell, useShell } from '../../components/app-shell';
import { EmptyState, ErrorBanner, Kpi, KpiSkeleton, SkeletonRows, usePagedRows } from '../../components/ui';
import { apiRequest } from '../../lib/api';
import {
  CampaignFunnel,
  CampaignSummary,
  addFunnel,
  zeroFunnelTotals,
} from '../../lib/campaign-metrics';
import { fmtBRL, fmtInt } from '../../lib/format';
import { isCollosRole } from '../../lib/session';

interface CampaignItem {
  id: string;
  clientId: string | null;
  name: string;
  integrationId: string;
  createdAt: string;
  summary: CampaignSummary;
  funnel: CampaignFunnel;
  template?: { name: string } | null;
  list?: { name: string } | null;
}

interface Integration {
  id: string;
  name: string;
}

// `estimatedAmount` é placeholder (sempre 0): não há precificação implementada
// aqui nem no backend (`dashboard.service.ts:77,134`).
const zero = () => ({ ...zeroFunnelTotals(), estimatedAmount: 0 });

export default function BillingPage() {
  return (
    <AppShell title="Cobrança">
      <BillingContent />
    </AppShell>
  );
}

function BillingContent() {
  const { session, clients, scopeClientId } = useShell();
  const collos = isCollosRole(session.role);
  const [campaigns, setCampaigns] = useState<CampaignItem[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [integrationFilter, setIntegrationFilter] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    void apiRequest<CampaignItem[]>('/campaigns')
      .then((data) => {
        setCampaigns(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar uso.');
        setLoading(false);
      });
    if (collos) {
      void apiRequest<Integration[]>('/integrations').then(setIntegrations).catch(() => undefined);
    }
  }, [collos]);

  useEffect(() => {
    load();
  }, [load]);

  const clientName = (id: string | null): string =>
    id ? clients.find((c) => c.id === id)?.name ?? '—' : 'Pool Collos';

  const filtered = useMemo(() => {
    return campaigns.filter((c) => {
      if (scopeClientId && c.clientId !== scopeClientId) return false;
      if (integrationFilter && c.integrationId !== integrationFilter) return false;
      const day = c.createdAt.slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;
      return true;
    });
  }, [campaigns, scopeClientId, integrationFilter, from, to]);

  const kpis = useMemo(() => {
    const acc = zero();
    // Funil acumulado (não os baldes de `summary`): Enviadas >= Entregues >= Lidas.
    for (const c of filtered) addFunnel(acc, c.funnel);
    return acc;
  }, [filtered]);

  const byClient = useMemo(() => {
    const map = new Map<string, ReturnType<typeof zero> & { clientId: string | null }>();
    for (const c of filtered) {
      const key = c.clientId ?? '__none__';
      const entry = map.get(key) ?? { ...zero(), clientId: c.clientId };
      addFunnel(entry, c.funnel);
      map.set(key, entry);
    }
    return [...map.values()].sort((a, b) => b.sentTotal - a.sentTotal);
  }, [filtered]);

  const clientRows = usePagedRows(byClient, 'cliente(s)');
  const campaignRows = usePagedRows(filtered, 'campanha(s)');

  const exportCsv = () => {
    const header = [
      'Cliente',
      'Campanha',
      'Template',
      'Lista',
      'Aceitas',
      'Enviadas',
      'Entregues',
      'Lidas',
      'Falhas',
      'Valor estimado',
    ];
    const rows = filtered.map((c) => [
      clientName(c.clientId),
      c.name,
      c.template?.name ?? '',
      c.list?.name ?? '',
      c.funnel.accepted,
      c.funnel.sentTotal,
      c.funnel.deliveredTotal,
      c.funnel.readTotal,
      c.funnel.failed,
      '0',
    ]);
    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'cobranca.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="op-head">
        <div className="op-head-titles">
          <h1 className="op-title">Cobrança</h1>
          <p className="op-sub">Uso por cliente e por campanha no período.</p>
        </div>
        <div className="op-actions">
          <button className="btn secondary md" onClick={exportCsv} disabled={filtered.length === 0}>
            Exportar CSV
          </button>
        </div>
      </div>

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}

      <div className="toolbar">
        <div className="field" style={{ gap: 2 }}>
          <span className="flt-label">Início</span>
          <input className="flt" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field" style={{ gap: 2 }}>
          <span className="flt-label">Fim</span>
          <input className="flt" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
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
      </div>

      <div className="kpi-grid k6 block">
        {loading ? (
          <KpiSkeleton count={6} />
        ) : (
          <>
            <Kpi label="Aceitas" value={fmtInt(kpis.accepted)} />
            <Kpi label="Enviadas" value={fmtInt(kpis.sentTotal)} />
            <Kpi label="Entregues" value={fmtInt(kpis.deliveredTotal)} />
            <Kpi label="Lidas" value={fmtInt(kpis.readTotal)} />
            <Kpi label="Falhas" value={fmtInt(kpis.failed)} />
            <Kpi label="Valor estimado" value={fmtBRL(kpis.estimatedAmount)} />
          </>
        )}
      </div>

      {collos ? (
        <div className="block">
          <div className="block-head">
            <span className="block-title">Uso por cliente</span>
          </div>
          <div className="tbl-wrap">
            <table className="tbl dense">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th className="num">Campanhas</th>
                  <th className="num">Aceitas</th>
                  <th className="num">Enviadas</th>
                  <th className="num">Entregues</th>
                  <th className="num">Lidas</th>
                  <th className="num">Falhas</th>
                  <th className="num">Valor estimado</th>
                </tr>
              </thead>
              {loading ? (
                <SkeletonRows rows={4} cols={8} />
              ) : (
                <tbody>
                  {byClient.length === 0 ? (
                    <tr>
                      <td colSpan={8}>
                        <EmptyState title="Sem uso no período" />
                      </td>
                    </tr>
                  ) : (
                    clientRows.pageRows.map((row) => (
                      <tr key={row.clientId ?? 'none'}>
                        <td className="cell-strong">{clientName(row.clientId)}</td>
                        <td className="num">{fmtInt(row.campaigns)}</td>
                        <td className="num">{fmtInt(row.accepted)}</td>
                        <td className="num">{fmtInt(row.sentTotal)}</td>
                        <td className="num">{fmtInt(row.deliveredTotal)}</td>
                        <td className="num">{fmtInt(row.readTotal)}</td>
                        <td className="num">{fmtInt(row.failed)}</td>
                        <td className="num">{fmtBRL(row.estimatedAmount)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              )}
            </table>
            {clientRows.pager}
          </div>
        </div>
      ) : null}

      <div className="block">
        <div className="block-head">
          <span className="block-title">Uso por campanha</span>
        </div>
        <div className="tbl-wrap">
          <table className="tbl dense">
            <thead>
              <tr>
                {collos ? <th>Cliente</th> : null}
                <th>Campanha</th>
                <th>Template</th>
                <th>Lista</th>
                <th className="num">Aceitas</th>
                <th className="num">Enviadas</th>
                <th className="num">Entregues</th>
                <th className="num">Lidas</th>
                <th className="num">Falhas</th>
                <th className="num">Valor estimado</th>
              </tr>
            </thead>
            {loading ? (
              <SkeletonRows rows={6} cols={collos ? 10 : 9} />
            ) : (
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={collos ? 10 : 9}>
                      <EmptyState title="Sem uso no período" />
                    </td>
                  </tr>
                ) : (
                  campaignRows.pageRows.map((c) => (
                    <tr key={c.id}>
                      {collos ? <td className="cell-sub">{clientName(c.clientId)}</td> : null}
                      <td className="cell-strong">{c.name}</td>
                      <td className="cell-sub">{c.template?.name ?? '—'}</td>
                      <td className="cell-sub">{c.list?.name ?? '—'}</td>
                      {/* Funil acumulado (não os baldes de `summary`): Enviadas >= Entregues >= Lidas. */}
                      <td className="num">{fmtInt(c.funnel.accepted)}</td>
                      <td className="num">{fmtInt(c.funnel.sentTotal)}</td>
                      <td className="num">{fmtInt(c.funnel.deliveredTotal)}</td>
                      <td className="num">{fmtInt(c.funnel.readTotal)}</td>
                      <td className="num">{fmtInt(c.funnel.failed)}</td>
                      <td className="num">{fmtBRL(0)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            )}
          </table>
          {campaignRows.pager}
        </div>
      </div>
    </>
  );
}
