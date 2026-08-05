'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell, useShell } from '../../components/app-shell';
import {
  Badge,
  EmptyState,
  ErrorBanner,
  Forbidden,
  Kpi,
  KpiSkeleton,
  SkeletonRows,
  ToastHost,
  usePagedRows,
  useToasts,
} from '../../components/ui';
import { apiDownload, apiRequest } from '../../lib/api';
import { CAMPAIGN_STATUS, badgeFor } from '../../lib/badges';
import { fmtBRL, fmtDateTime, fmtInt } from '../../lib/format';
import { Role, isCollosRole } from '../../lib/session';

/* ---- Contrato de GET /reports/campaigns ---------------------------------- */

interface SendBuckets {
  pending: number;
  accepted: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  total: number;
}

interface FunnelBlock {
  total: number;
  pending: number;
  accepted: number;
  sentTotal: number;
  deliveredTotal: number;
  readTotal: number;
  failed: number;
  skipped: number;
  deliveryRate: number;
  readRate: number;
}

interface BillableCategoryLine {
  category: string;
  billableCount: number;
  unitPriceBrl: number | null;
  missingRate: boolean;
  subtotalBrl: number;
}

interface CostBlock {
  billableTotal: number;
  subtotalBrl: number;
  notaFiscalPct: number;
  notaFiscalValorBrl: number;
  totalBrl: number;
  hasMissingRate: boolean;
  currency: string;
}

interface CampaignReportRow {
  campaignId: string;
  name: string;
  clientId: string | null;
  status: string;
  listId: string | null;
  listNames: string[];
  startedAt: string | null;
  finishedAt: string | null;
  sends: SendBuckets;
  funnel: FunnelBlock;
  billableByCategory: BillableCategoryLine[];
  cost: CostBlock;
}

interface ReportTotals {
  campaigns: number;
  sends: SendBuckets;
  billableByCategory: BillableCategoryLine[];
  billableTotal: number;
  subtotalBrl: number;
  notaFiscalPct: number;
  notaFiscalValorBrl: number;
  totalBrl: number;
  hasMissingRate: boolean;
}

interface CampaignsReport {
  period: { from: string | null; to: string | null };
  clientId: string | null;
  currency: string;
  notaFiscalPct: number;
  generatedAt: string;
  campaigns: CampaignReportRow[];
  totals: ReportTotals;
}

/* ---- Contrato de tarifas / configuração ---------------------------------- */

interface PricingRate {
  id: string;
  clientId?: string | null;
  category: string;
  unitPriceBrl: number;
  effectiveFrom: string;
  createdAt: string;
  updatedAt: string;
}

interface ReportSettings {
  clientId?: string | null;
  notaFiscalPct: number;
  updatedAt: string;
}

const RATE_CATEGORIES = ['MARKETING', 'UTILITY', 'AUTHENTICATION', 'SERVICE'] as const;
type RateCategory = (typeof RATE_CATEGORIES)[number];

const CATEGORY_LABELS: Record<string, string> = {
  MARKETING: 'Marketing',
  UTILITY: 'Utilidade',
  AUTHENTICATION: 'Autenticação',
  SERVICE: 'Serviço',
};

const catLabel = (category: string): string => CATEGORY_LABELS[category] ?? category;

// Quem pode VER o relatório de custos — espelha o RolesGuard do backend após a
// revisão de segurança: admins Collos + admin do cliente (viewer/operator fora).
const REPORT_VIEW_ROLES: Role[] = ['super_admin', 'admin', 'client_admin'];
const canViewReports = (role: Role): boolean => REPORT_VIEW_ROLES.includes(role);

// Quem pode ADMINISTRAR tarifas/NF — apenas Collos (super_admin/admin).
// client_admin passou a só visualizar; espelha o novo @Roles do backend.
const canAdminRates = (role: Role): boolean => isCollosRole(role);

/* ---- Períodos ------------------------------------------------------------ */

const toDateInput = (date: Date): string => date.toISOString().slice(0, 10);

const daysAgo = (days: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return toDateInput(date);
};

const monthStart = (): string => {
  const date = new Date();
  return toDateInput(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
};

const fmtPct = (value: number | null | undefined): string =>
  `${(value ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

const fmtPeriod = (from: string | null, to: string | null): string => {
  if (!from && !to) return '—';
  return `${fmtDateTime(from).replace(', 00:00', '')} → ${to ? fmtDateTime(to) : '—'}`;
};

export default function ReportsPage() {
  return (
    <AppShell title="Relatórios">
      <ReportsContent />
    </AppShell>
  );
}

function ReportsContent() {
  const { session } = useShell();
  const admin = canAdminRates(session.role);
  const [tab, setTab] = useState<'report' | 'rates'>('report');

  if (!canViewReports(session.role)) {
    return (
      <>
        <div className="op-head">
          <div className="op-head-titles">
            <h1 className="op-title">Relatórios</h1>
            <p className="op-sub">Custos de campanhas por período, com tarifas e nota fiscal.</p>
          </div>
        </div>
        <Forbidden
          title="Acesso restrito"
          desc="O relatório de custos está disponível apenas para administradores."
        />
      </>
    );
  }

  return (
    <>
      <div className="op-head">
        <div className="op-head-titles">
          <h1 className="op-title">Relatórios</h1>
          <p className="op-sub">Custos de campanhas por período, com tarifas e nota fiscal.</p>
        </div>
      </div>

      {admin ? (
        <div className="tabs-list page-tabs">
          <button
            className={`tab-trigger${tab === 'report' ? ' active' : ''}`}
            onClick={() => setTab('report')}
          >
            Relatório de campanhas
          </button>
          <button
            className={`tab-trigger${tab === 'rates' ? ' active' : ''}`}
            onClick={() => setTab('rates')}
          >
            Tarifas e nota fiscal
          </button>
        </div>
      ) : null}

      {tab === 'report' || !admin ? (
        <ReportTab canAdminRates={admin} onGoToRates={() => setTab('rates')} />
      ) : (
        <RatesTab />
      )}
    </>
  );
}

/* ---- Aba: relatório ------------------------------------------------------ */

function ReportTab({
  canAdminRates: admin,
  onGoToRates,
}: {
  canAdminRates: boolean;
  onGoToRates: () => void;
}) {
  const { scopeClientId } = useShell();
  const [from, setFrom] = useState<string>(() => daysAgo(30));
  const [to, setTo] = useState<string>(() => toDateInput(new Date()));
  const [report, setReport] = useState<CampaignsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (scopeClientId) params.set('clientId', scopeClientId);
    return params.toString();
  }, [from, to, scopeClientId]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    void apiRequest<CampaignsReport>(`/reports/campaigns${query ? `?${query}` : ''}`)
      .then((data) => {
        setReport(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar o relatório.');
        setLoading(false);
      });
  }, [query]);

  useEffect(() => {
    load();
  }, [load]);

  const totals = report?.totals;
  const campaigns = report?.campaigns ?? [];
  const { pageRows, pager } = usePagedRows(campaigns, 'campanha(s)');

  const preset = (nextFrom: string, nextTo: string) => {
    setFrom(nextFrom);
    setTo(nextTo);
  };
  const today = toDateInput(new Date());
  const activePreset =
    to === today && from === daysAgo(7)
      ? '7'
      : to === today && from === daysAgo(30)
        ? '30'
        : to === today && from === monthStart()
          ? 'month'
          : '';

  const exportCsv = () => {
    void apiDownload(
      `/reports/campaigns/export.csv${query ? `?${query}` : ''}`,
      'relatorio-campanhas.csv',
    ).catch(() => undefined);
  };
  const exportPdf = () => {
    void apiDownload(
      `/reports/campaigns/export.pdf${query ? `?${query}` : ''}`,
      'relatorio-campanhas.pdf',
    ).catch(() => undefined);
  };

  return (
    <>
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
        <div className="row" style={{ gap: 6 }}>
          <button
            className={`btn ${activePreset === '7' ? 'secondary' : 'tertiary'} sm`}
            onClick={() => preset(daysAgo(7), today)}
          >
            Últimos 7 dias
          </button>
          <button
            className={`btn ${activePreset === '30' ? 'secondary' : 'tertiary'} sm`}
            onClick={() => preset(daysAgo(30), today)}
          >
            Últimos 30 dias
          </button>
          <button
            className={`btn ${activePreset === 'month' ? 'secondary' : 'tertiary'} sm`}
            onClick={() => preset(monthStart(), today)}
          >
            Mês atual
          </button>
        </div>
        <div className="op-actions" style={{ marginLeft: 'auto' }}>
          <button
            className="btn secondary md"
            onClick={exportCsv}
            disabled={loading || campaigns.length === 0}
          >
            Exportar CSV
          </button>
          <button
            className="btn secondary md"
            onClick={exportPdf}
            disabled={loading || campaigns.length === 0}
          >
            Exportar PDF
          </button>
        </div>
      </div>

      {totals?.hasMissingRate ? (
        <div className="toast warning" style={{ marginBottom: 16 }}>
          <span style={{ flex: 1 }}>
            Há categorias sem tarifa cadastrada no período — o custo dessas categorias sai como R$
            0,00. Cadastre as tarifas para ver o valor correto.
          </span>
          {admin ? (
            <button className="btn secondary sm" onClick={onGoToRates}>
              Cadastrar tarifas
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="kpi-grid block">
        {loading ? (
          <KpiSkeleton count={8} />
        ) : (
          <>
            <Kpi label="Envios totais" value={fmtInt(totals?.sends.total)} />
            <Kpi label="Entregues" value={fmtInt(totals?.sends.delivered)} />
            <Kpi label="Lidas" value={fmtInt(totals?.sends.read)} />
            <Kpi label="Falhas" value={fmtInt(totals?.sends.failed)} />
            <Kpi label="Cobráveis" value={fmtInt(totals?.billableTotal)} />
            <Kpi label="Subtotal" value={fmtBRL(totals?.subtotalBrl)} />
            <Kpi
              label="Nota fiscal"
              value={fmtBRL(totals?.notaFiscalValorBrl)}
              foot={`${fmtPct(totals?.notaFiscalPct)} sobre o subtotal`}
            />
            <Kpi label="Total" value={fmtBRL(totals?.totalBrl)} />
          </>
        )}
      </div>

      <div className="block">
        <div className="block-head">
          <span className="block-title">Cobráveis por categoria</span>
        </div>
        <div className="tbl-wrap">
          <table className="tbl dense">
            <thead>
              <tr>
                <th>Categoria</th>
                <th className="num">Cobráveis</th>
                <th className="num">Tarifa unitária</th>
                <th className="num">Subtotal</th>
              </tr>
            </thead>
            {loading ? (
              <SkeletonRows rows={3} cols={4} />
            ) : (
              <tbody>
                {(totals?.billableByCategory ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={4}>
                      <EmptyState title="Sem cobráveis no período" />
                    </td>
                  </tr>
                ) : (
                  totals?.billableByCategory.map((line) => (
                    <tr key={line.category}>
                      <td className="cell-strong">{catLabel(line.category)}</td>
                      <td className="num">{fmtInt(line.billableCount)}</td>
                      <td className="num">
                        {line.missingRate ? (
                          <span className="badge warning">Sem tarifa</span>
                        ) : (
                          fmtBRL(line.unitPriceBrl)
                        )}
                      </td>
                      <td className="num">{fmtBRL(line.subtotalBrl)}</td>
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
          <span className="block-title">Custo por campanha</span>
        </div>
        <div className="tbl-wrap">
          <table className="tbl dense">
            <thead>
              <tr>
                <th>Campanha</th>
                <th>Status</th>
                <th>Período</th>
                <th className="num">Enviadas</th>
                <th className="num">Entregues</th>
                <th className="num">Lidas</th>
                <th className="num">Falhas</th>
                <th className="num">Entrega</th>
                <th className="num">Leitura</th>
                <th className="num">Cobráveis</th>
                <th className="num">Subtotal</th>
                <th className="num">NF</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            {loading ? (
              <SkeletonRows rows={6} cols={13} />
            ) : (
              <tbody>
                {campaigns.length === 0 ? (
                  <tr>
                    <td colSpan={13}>
                      <EmptyState title="Sem campanhas no período" />
                    </td>
                  </tr>
                ) : (
                  pageRows.map((c) => (
                    <tr key={c.campaignId}>
                      <td>
                        <div className="cell-strong">{c.name}</div>
                        {c.listNames.length > 0 ? (
                          <div className="cell-sub">{c.listNames.join(', ')}</div>
                        ) : null}
                      </td>
                      <td>
                        <Badge def={badgeFor(CAMPAIGN_STATUS, c.status)} />
                      </td>
                      <td className="cell-mono">{fmtPeriod(c.startedAt, c.finishedAt)}</td>
                      <td className="num">{fmtInt(c.funnel.sentTotal)}</td>
                      <td className="num">{fmtInt(c.funnel.deliveredTotal)}</td>
                      <td className="num">{fmtInt(c.funnel.readTotal)}</td>
                      <td className="num">{fmtInt(c.funnel.failed)}</td>
                      <td className="num">{fmtPct(c.funnel.deliveryRate)}</td>
                      <td className="num">{fmtPct(c.funnel.readRate)}</td>
                      <td className="num">{fmtInt(c.cost.billableTotal)}</td>
                      <td className="num">{fmtBRL(c.cost.subtotalBrl)}</td>
                      <td className="num">{fmtBRL(c.cost.notaFiscalValorBrl)}</td>
                      <td className="num">
                        {c.cost.hasMissingRate ? (
                          <span title="Faltam tarifas cadastradas">{fmtBRL(c.cost.totalBrl)} *</span>
                        ) : (
                          fmtBRL(c.cost.totalBrl)
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            )}
          </table>
          {pager}
        </div>
      </div>
    </>
  );
}

/* ---- Aba: tarifas e nota fiscal ------------------------------------------ */

const emptyPrices = (): Record<RateCategory, string> => ({
  MARKETING: '',
  UTILITY: '',
  AUTHENTICATION: '',
  SERVICE: '',
});

function RatesTab() {
  const { toasts, push } = useToasts();
  const [priceByCat, setPriceByCat] = useState<Record<RateCategory, string>>(emptyPrices);
  const [nfPct, setNfPct] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingCat, setSavingCat] = useState<RateCategory | null>(null);
  const [savingNf, setSavingNf] = useState(false);

  // Modelo simplificado (WABA-23): UM valor por categoria, GLOBAL. Carregamos e
  // gravamos SEM clientId — a edição ignora o seletor de tenant da topbar.
  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      apiRequest<PricingRate[]>('/reports/rates'),
      apiRequest<ReportSettings>('/reports/settings'),
    ])
      .then(([rateList, cfg]) => {
        const next = emptyPrices();
        for (const rate of rateList) {
          const cat = rate.category as RateCategory;
          if (cat in next) next[cat] = String(rate.unitPriceBrl);
        }
        setPriceByCat(next);
        setNfPct(String(cfg.notaFiscalPct ?? ''));
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Falha ao carregar tarifas.');
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saveRate = (category: RateCategory) => {
    const price = Number((priceByCat[category] ?? '').replace(',', '.'));
    if (!Number.isFinite(price) || price < 0) {
      push('danger', 'Informe um preço unitário válido.');
      return;
    }
    setSavingCat(category);
    void apiRequest<PricingRate>('/reports/rates', {
      method: 'POST',
      // Sempre global: sem clientId (a tarifa vale para todos os clientes).
      body: JSON.stringify({ category, unitPriceBrl: price }),
    })
      .then((rate) => {
        setPriceByCat((cur) => ({ ...cur, [category]: String(rate.unitPriceBrl) }));
        push('success', `Tarifa de ${catLabel(category)} atualizada para todos os clientes.`);
      })
      .catch((err) => {
        push('danger', err instanceof Error ? err.message : 'Falha ao salvar a tarifa.');
      })
      .finally(() => setSavingCat(null));
  };

  const saveSettings = () => {
    const pct = Number(nfPct.replace(',', '.'));
    if (!Number.isFinite(pct) || pct < 0) {
      push('danger', 'Informe um percentual de NF válido.');
      return;
    }
    setSavingNf(true);
    void apiRequest<ReportSettings>('/reports/settings', {
      method: 'PUT',
      // Global: sem clientId.
      body: JSON.stringify({ notaFiscalPct: pct }),
    })
      .then((cfg) => {
        setNfPct(String(cfg.notaFiscalPct));
        push('success', 'Percentual de nota fiscal atualizado para todos os clientes.');
      })
      .catch((err) => {
        push('danger', err instanceof Error ? err.message : 'Falha ao salvar a configuração.');
      })
      .finally(() => setSavingNf(false));
  };

  return (
    <>
      <ToastHost toasts={toasts} />
      {error ? <ErrorBanner message={error} onRetry={load} /> : null}

      <div className="toast warning" style={{ marginBottom: 16 }}>
        <span style={{ flex: 1 }}>
          Estas tarifas e o percentual de nota fiscal são <strong>globais</strong>: valem para
          todos os clientes e só o ADM Master pode alterá-los. A mudança passa a valer em todos os
          relatórios imediatamente. O seletor de tenant afeta apenas a leitura do relatório.
        </span>
      </div>

      <div className="block">
        <div className="block-head">
          <span className="block-title">Tarifas padrão (valem para todos os clientes)</span>
        </div>
        <div className="tbl-wrap">
          <table className="tbl dense">
            <thead>
              <tr>
                <th>Categoria</th>
                <th className="num">Preço unitário (BRL)</th>
                <th></th>
              </tr>
            </thead>
            {loading ? (
              <SkeletonRows rows={4} cols={3} />
            ) : (
              <tbody>
                {RATE_CATEGORIES.map((cat) => (
                  <tr key={cat}>
                    <td className="cell-strong">{catLabel(cat)}</td>
                    <td className="num">
                      <input
                        className="input"
                        inputMode="decimal"
                        placeholder="0,00"
                        style={{ maxWidth: 140, marginLeft: 'auto', textAlign: 'right' }}
                        value={priceByCat[cat]}
                        onChange={(e) =>
                          setPriceByCat((cur) => ({ ...cur, [cat]: e.target.value }))
                        }
                      />
                    </td>
                    <td>
                      <button
                        className="btn secondary sm"
                        disabled={savingCat === cat}
                        onClick={() => saveRate(cat)}
                      >
                        Salvar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
      </div>

      <div className="block">
        <div className="block-head">
          <span className="block-title">Nota fiscal (global)</span>
        </div>
        <div className="panel">
          <div className="field" style={{ maxWidth: 260 }}>
            <label>Percentual sobre o subtotal (%)</label>
            <input
              className="input"
              inputMode="decimal"
              placeholder="10,98"
              value={nfPct}
              onChange={(e) => setNfPct(e.target.value)}
            />
          </div>
          <p className="op-sub" style={{ marginTop: 8 }}>
            Imposto aditivo: total = subtotal + subtotal × percentual. Vale para todos os clientes.
          </p>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary md" onClick={saveSettings} disabled={savingNf || loading}>
              Salvar percentual
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
