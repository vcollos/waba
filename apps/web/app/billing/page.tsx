'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell, useShell } from '../../components/app-shell';
import { EmptyState, ErrorBanner, Kpi, KpiSkeleton, SkeletonRows } from '../../components/ui';
import { apiRequest } from '../../lib/api';
import { fmtBRL, fmtInt } from '../../lib/format';
import { isCollosRole } from '../../lib/session';

interface CampaignSummary {
  accepted: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
}

interface CampaignItem {
  id: string;
  clientId: string | null;
  name: string;
  integrationId: string;
  createdAt: string;
  summary: CampaignSummary;
  template?: { name: string } | null;
  list?: { name: string } | null;
}

interface Integration {
  id: string;
  name: string;
}

const zero = () => ({ accepted: 0, sent: 0, delivered: 0, read: 0, failed: 0, campaigns: 0, estimatedAmount: 0 });

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
    const effectiveClient = collos ? scopeClientId : session.clientId ?? null;
    return campaigns.filter((c) => {
      if (effectiveClient && c.clientId !== effectiveClient) return false;
      if (integrationFilter && c.integrationId !== integrationFilter) return false;
      const day = c.createdAt.slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;
      return true;
    });
  }, [campaigns, collos, scopeClientId, session.clientId, integrationFilter, from, to]);

  const kpis = useMemo(() => {
    const acc = zero();
    for (const c of filtered) {
      acc.accepted += c.summary.accepted;
      acc.sent += c.summary.sent;
      acc.delivered += c.summary.delivered;
      acc.read += c.summary.read;
      acc.failed += c.summary.failed;
      acc.campaigns += 1;
    }
    return acc;
  }, [filtered]);

  const byClient = useMemo(() => {
    const map = new Map<string, ReturnType<typeof zero> & { clientId: string | null }>();
    for (const c of filtered) {
      const key = c.clientId ?? '__none__';
      const entry = map.get(key) ?? { ...zero(), clientId: c.clientId };
      entry.accepted += c.summary.accepted;
      entry.sent += c.summary.sent;
      entry.delivered += c.summary.delivered;
      entry.read += c.summary.read;
      entry.failed += c.summary.failed;
      entry.campaigns += 1;
      map.set(key, entry);
    }
    return [...map.values()].sort((a, b) => b.sent - a.sent);
  }, [filtered]);

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
      c.summary.accepted,
      c.summary.sent,
      c.summary.delivered,
      c.summary.read,
      c.summary.failed,
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
            <Kpi label="Enviadas" value={fmtInt(kpis.sent)} />
            <Kpi label="Entregues" value={fmtInt(kpis.delivered)} />
            <Kpi label="Lidas" value={fmtInt(kpis.read)} />
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
                    byClient.map((row) => (
                      <tr key={row.clientId ?? 'none'}>
                        <td className="cell-strong">{clientName(row.clientId)}</td>
                        <td className="num">{fmtInt(row.campaigns)}</td>
                        <td className="num">{fmtInt(row.accepted)}</td>
                        <td className="num">{fmtInt(row.sent)}</td>
                        <td className="num">{fmtInt(row.delivered)}</td>
                        <td className="num">{fmtInt(row.read)}</td>
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
                  filtered.map((c) => (
                    <tr key={c.id}>
                      {collos ? <td className="cell-sub">{clientName(c.clientId)}</td> : null}
                      <td className="cell-strong">{c.name}</td>
                      <td className="cell-sub">{c.template?.name ?? '—'}</td>
                      <td className="cell-sub">{c.list?.name ?? '—'}</td>
                      <td className="num">{fmtInt(c.summary.accepted)}</td>
                      <td className="num">{fmtInt(c.summary.sent)}</td>
                      <td className="num">{fmtInt(c.summary.delivered)}</td>
                      <td className="num">{fmtInt(c.summary.read)}</td>
                      <td className="num">{fmtInt(c.summary.failed)}</td>
                      <td className="num">{fmtBRL(0)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            )}
          </table>
        </div>
      </div>
    </>
  );
}
