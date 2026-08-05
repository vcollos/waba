import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { buildCsv } from '../common/csv';
import { campaignFunnel } from '../common/campaign-metrics';
import { DEFAULT_NOTA_FISCAL_PCT, isCollosRole } from '../database/types';
import { writeClientId } from '../common/scope';
import { DatabaseService } from '../database/database.service';
import { nowIso } from '../database/helpers';
import type {
  CampaignMessageRecord,
  CampaignRecord,
  PricingRateRecord,
  ReportSettingsRecord,
  UserSession,
} from '../database/types';

/** Categoria usada quando a mensagem cobrável ainda não tem pricingCategory. */
const UNKNOWN_CATEGORY = 'UNKNOWN';

export interface ReportPeriod {
  from?: string | null;
  to?: string | null;
}

interface BillableCategoryLine {
  category: string;
  billableCount: number;
  /** Tarifa unitária vigente (BRL). `null` quando não há tarifa cadastrada. */
  unitPriceBrl: number | null;
  /** true = sem tarifa cadastrada p/ (tenant, categoria, data): custo tratado como 0. */
  missingRate: boolean;
  subtotalBrl: number;
}

interface SendBuckets {
  pending: number;
  accepted: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  total: number;
}

@Injectable()
export class ReportsService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Relatório consolidado de campanhas do período. `scope` já vem resolvido pelo
   * controller (resolveClientScope): `null` = todos os tenants (só Collos);
   * string = tenant único; `__none__` = fail-closed (nada visível).
   */
  async campaignsReport(period: ReportPeriod, scope: string | null) {
    const from = normalizeFromBound(period.from);
    const to = normalizeToBound(period.to);
    if (from && to && from > to) {
      throw new BadRequestException('Intervalo inválido: "from" posterior a "to".');
    }

    const state = await this.database.readMetaSnapshot();
    // Escopo de tenant: cliente só enxerga campanhas do próprio tenant; Collos
    // (scope null) vê tudo; scope inválido (__none__) não casa com nenhum clientId.
    const scopedCampaigns =
      scope === null
        ? state.campaigns
        : state.campaigns.filter((campaign) => (campaign.clientId ?? null) === scope);
    const scopedCampaignIds = new Set(scopedCampaigns.map((campaign) => campaign.id));
    const campaignsById = new Map(scopedCampaigns.map((campaign) => [campaign.id, campaign]));
    const listNamesById = new Map(state.lists.map((list) => [list.id, list.name]));

    const allMessages = await this.database.listCampaignMessagesInDatabase();
    // Data de referência da mensagem p/ recorte de período e tarifa vigente:
    // quando foi enviada (sentAt); cai em createdAt se ainda não saiu.
    const periodMessages = allMessages.filter((message) => {
      if (!scopedCampaignIds.has(message.campaignId)) {
        return false;
      }
      const ref = messageRefDate(message);
      if (from && ref < from) {
        return false;
      }
      if (to && ref > to) {
        return false;
      }
      return true;
    });

    const messagesByCampaign = new Map<string, CampaignMessageRecord[]>();
    for (const message of periodMessages) {
      const bucket = messagesByCampaign.get(message.campaignId) ?? [];
      bucket.push(message);
      messagesByCampaign.set(message.campaignId, bucket);
    }

    // Cache de tarifas e settings por tenant (evita N consultas repetidas).
    const rateCache = new Map<string, PricingRateRecord | null>();
    const settingsCache = new Map<string, ReportSettingsRecord>();
    const resolveRate = async (
      clientId: string | null,
      category: string,
      atDate: string,
    ): Promise<PricingRateRecord | null> => {
      const key = `${clientId ?? ''}|${category}|${atDate}`;
      if (rateCache.has(key)) {
        return rateCache.get(key) ?? null;
      }
      const rate = await this.database.resolvePricingRate(clientId, category, atDate);
      rateCache.set(key, rate);
      return rate;
    };
    const resolveSettings = async (clientId: string | null): Promise<ReportSettingsRecord> => {
      const key = clientId ?? '';
      const cached = settingsCache.get(key);
      if (cached) {
        return cached;
      }
      const settings = await this.database.getReportSettings(clientId);
      settingsCache.set(key, settings);
      return settings;
    };

    const campaignsPayload = [];
    for (const [campaignId, messages] of messagesByCampaign.entries()) {
      const campaign = campaignsById.get(campaignId);
      if (!campaign) {
        continue;
      }
      const refDate = campaignRefDate(campaign, to);
      const sends = buildSendBuckets(messages);
      const funnel = campaignFunnel(buildSummary(messages));

      // Cobráveis por categoria: campaign_messages do período com billable=true.
      const billableCounts = new Map<string, number>();
      for (const message of messages) {
        if (message.pricingBillable !== true) {
          continue;
        }
        const category = (message.pricingCategory ?? UNKNOWN_CATEGORY).trim().toUpperCase() || UNKNOWN_CATEGORY;
        billableCounts.set(category, (billableCounts.get(category) ?? 0) + 1);
      }

      const billableByCategory: BillableCategoryLine[] = [];
      for (const [category, count] of [...billableCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const rate = await resolveRate(campaign.clientId ?? null, category, refDate);
        const unitPriceBrl = rate?.unitPriceBrl ?? null;
        const subtotalBrl = round2(count * (unitPriceBrl ?? 0));
        billableByCategory.push({
          category,
          billableCount: count,
          unitPriceBrl,
          missingRate: rate === null,
          subtotalBrl,
        });
      }

      const settings = await resolveSettings(campaign.clientId ?? null);
      const subtotalBrl = round2(billableByCategory.reduce((sum, line) => sum + line.subtotalBrl, 0));
      const notaFiscalPct = settings.notaFiscalPct;
      const notaFiscalValorBrl = round2((subtotalBrl * notaFiscalPct) / 100);
      const totalBrl = round2(subtotalBrl + notaFiscalValorBrl);
      const billableTotal = billableByCategory.reduce((sum, line) => sum + line.billableCount, 0);

      campaignsPayload.push({
        campaignId: campaign.id,
        name: campaign.name,
        clientId: campaign.clientId ?? null,
        status: campaign.status,
        listId: campaign.listId,
        listNames: campaign.listId
          ? [listNamesById.get(campaign.listId) ?? campaign.listId]
          : [],
        startedAt: campaign.startedAt ?? null,
        finishedAt: campaign.finishedAt ?? null,
        sends,
        funnel,
        billableByCategory,
        cost: {
          billableTotal,
          subtotalBrl,
          notaFiscalPct,
          notaFiscalValorBrl,
          totalBrl,
          hasMissingRate: billableByCategory.some((line) => line.missingRate),
          currency: 'BRL' as const,
        },
      });
    }

    campaignsPayload.sort((left, right) => right.cost.totalBrl - left.cost.totalBrl);

    // Consolidado do período: soma de envios + cobráveis por categoria e dinheiro.
    const totalsSends = emptyBuckets();
    const totalsCategory = new Map<string, { count: number; subtotal: number; missing: boolean; prices: Set<number> }>();
    let subtotalBrl = 0;
    let notaFiscalValorBrl = 0;
    let totalBrl = 0;
    let hasMissingRate = false;
    for (const campaign of campaignsPayload) {
      addBuckets(totalsSends, campaign.sends);
      subtotalBrl += campaign.cost.subtotalBrl;
      notaFiscalValorBrl += campaign.cost.notaFiscalValorBrl;
      totalBrl += campaign.cost.totalBrl;
      hasMissingRate = hasMissingRate || campaign.cost.hasMissingRate;
      for (const line of campaign.billableByCategory) {
        const acc = totalsCategory.get(line.category) ?? {
          count: 0,
          subtotal: 0,
          missing: false,
          prices: new Set<number>(),
        };
        acc.count += line.billableCount;
        acc.subtotal += line.subtotalBrl;
        acc.missing = acc.missing || line.missingRate;
        if (line.unitPriceBrl !== null) {
          acc.prices.add(line.unitPriceBrl);
        }
        totalsCategory.set(line.category, acc);
      }
    }

    const headerSettings = await resolveSettings(scope === null ? null : scope);

    const consolidatedCategories: BillableCategoryLine[] = [...totalsCategory.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([category, acc]) => ({
        category,
        billableCount: acc.count,
        // unitPriceBrl consolidado só faz sentido quando a tarifa foi uniforme no
        // período/tenants; caso contrário, null (use subtotalBrl agregado).
        unitPriceBrl: acc.prices.size === 1 ? [...acc.prices][0] : null,
        missingRate: acc.missing,
        subtotalBrl: round2(acc.subtotal),
      }));

    return {
      period: { from: from ?? null, to: to ?? null },
      clientId: scope === '__none__' ? null : scope,
      currency: 'BRL' as const,
      notaFiscalPct: headerSettings.notaFiscalPct,
      generatedAt: nowIso(),
      campaigns: campaignsPayload,
      totals: {
        campaigns: campaignsPayload.length,
        sends: totalsSends,
        billableByCategory: consolidatedCategories,
        billableTotal: consolidatedCategories.reduce((sum, line) => sum + line.billableCount, 0),
        subtotalBrl: round2(subtotalBrl),
        // NF/total consolidados = soma dos valores por campanha (preserva pct
        // por tenant quando o escopo é global). notaFiscalPct é o do escopo.
        notaFiscalPct: headerSettings.notaFiscalPct,
        notaFiscalValorBrl: round2(notaFiscalValorBrl),
        totalBrl: round2(totalBrl),
        hasMissingRate,
      },
    };
  }

  async campaignsReportCsv(period: ReportPeriod, scope: string | null): Promise<string> {
    const report = await this.campaignsReport(period, scope);
    // Colunas dinâmicas de categoria cobrável (união de todas as categorias).
    const categories = report.totals.billableByCategory.map((line) => line.category);

    const header = [
      'campaignId',
      'campanha',
      'tenant',
      'status',
      'startedAt',
      'finishedAt',
      'pending',
      'accepted',
      'sent',
      'delivered',
      'read',
      'failed',
      'total',
      ...categories.map((category) => `cobravel_${category}`),
      'cobraveisTotal',
      'subtotalBrl',
      'notaFiscalPct',
      'notaFiscalValorBrl',
      'totalBrl',
      'tarifaFaltante',
    ];

    const rows = report.campaigns.map((campaign) => {
      const byCategory = new Map(campaign.billableByCategory.map((line) => [line.category, line.billableCount]));
      return [
        campaign.campaignId,
        campaign.name,
        campaign.clientId ?? '',
        campaign.status,
        campaign.startedAt ?? '',
        campaign.finishedAt ?? '',
        campaign.sends.pending,
        campaign.sends.accepted,
        campaign.sends.sent,
        campaign.sends.delivered,
        campaign.sends.read,
        campaign.sends.failed,
        campaign.sends.total,
        ...categories.map((category) => byCategory.get(category) ?? 0),
        campaign.cost.billableTotal,
        campaign.cost.subtotalBrl,
        campaign.cost.notaFiscalPct,
        campaign.cost.notaFiscalValorBrl,
        campaign.cost.totalBrl,
        campaign.cost.hasMissingRate ? 'sim' : 'nao',
      ];
    });

    const totalsByCategory = new Map(
      report.totals.billableByCategory.map((line) => [line.category, line.billableCount]),
    );
    rows.push([
      'TOTAL',
      `${report.totals.campaigns} campanha(s)`,
      '',
      '',
      report.period.from ?? '',
      report.period.to ?? '',
      report.totals.sends.pending,
      report.totals.sends.accepted,
      report.totals.sends.sent,
      report.totals.sends.delivered,
      report.totals.sends.read,
      report.totals.sends.failed,
      report.totals.sends.total,
      ...categories.map((category) => totalsByCategory.get(category) ?? 0),
      report.totals.billableTotal,
      report.totals.subtotalBrl,
      report.totals.notaFiscalPct,
      report.totals.notaFiscalValorBrl,
      report.totals.totalBrl,
      report.totals.hasMissingRate ? 'sim' : 'nao',
    ]);

    return buildCsv(header, rows);
  }

  /**
   * Relatório em HTML print-ready (o cliente imprime/salva como PDF pelo browser).
   * Decisão consciente: NÃO adicionamos puppeteer/headless chrome nem pdfkit para
   * não pesar no disco da VPS (86%). Zero dependência nova, zero binário.
   */
  async campaignsReportHtml(period: ReportPeriod, scope: string | null): Promise<string> {
    const report = await this.campaignsReport(period, scope);
    return renderReportHtml(report);
  }

  // --- Administração de tarifas ---------------------------------------------

  async listRates(scope: string | null): Promise<PricingRateRecord[]> {
    // Fail-closed: escopo impossível (cliente sem tenant) não pode cair no
    // fallback global (OR client_id IS NULL) do banco — devolve vazio sem I/O.
    if (scope === '__none__') {
      return [];
    }
    return this.database.listPricingRates(scope);
  }

  async upsertRate(
    session: UserSession,
    input: { id?: string; category?: string; unitPriceBrl?: number; effectiveFrom?: string; clientId?: string | null },
  ): Promise<PricingRateRecord> {
    const category = (input.category ?? '').trim();
    if (!category) {
      throw new BadRequestException('Categoria é obrigatória.');
    }
    const unitPriceBrl = Number(input.unitPriceBrl);
    if (!Number.isFinite(unitPriceBrl) || unitPriceBrl < 0) {
      throw new BadRequestException('unitPriceBrl inválido.');
    }
    const effectiveFrom = (input.effectiveFrom ?? '').trim() || nowIso();

    // Tenant a gravar: Collos pode global/qualquer tenant; papel de cliente é
    // forçado ao próprio tenant por writeClientId (não dá p/ burlar via body).
    const clientId = writeClientId(session, input.clientId);
    if (!isCollosRole(session.role) && clientId === null) {
      throw new ForbiddenException('Sem tenant válido para gravar a tarifa.');
    }

    // Defesa em profundidade (Samuel): o upsert é ON CONFLICT(id). Um chamador
    // não-Collos que envie o `id` de uma tarifa global ou de outro tenant
    // conseguiria reatribuir a linha para o próprio tenant. Bloqueamos: com `id`,
    // a tarifa existente tem de pertencer exatamente ao tenant resolvido da sessão.
    if (!isCollosRole(session.role) && (input.id ?? '').trim()) {
      const existing = (await this.database.listPricingRates(clientId)).find(
        (rate) => rate.id === input.id,
      );
      if (!existing || (existing.clientId ?? null) !== clientId) {
        throw new ForbiddenException('Tarifa fora do seu escopo.');
      }
    }

    return this.database.upsertPricingRate({
      id: input.id ?? '',
      clientId,
      category,
      unitPriceBrl,
      effectiveFrom,
      createdAt: '',
      updatedAt: '',
    });
  }

  // --- Configuração de relatórios (nota fiscal) -----------------------------

  async getSettings(scope: string | null): Promise<ReportSettingsRecord> {
    // Fail-closed: escopo impossível não pode ler a NF global (o banco cai no
    // fallback client_id IS NULL). Devolve o default sem tocar no banco.
    if (scope === '__none__') {
      return { clientId: null, notaFiscalPct: DEFAULT_NOTA_FISCAL_PCT, updatedAt: nowIso() };
    }
    return this.database.getReportSettings(scope);
  }

  async updateSettings(
    session: UserSession,
    input: { notaFiscalPct?: number; clientId?: string | null },
  ): Promise<ReportSettingsRecord> {
    const notaFiscalPct = Number(input.notaFiscalPct);
    if (!Number.isFinite(notaFiscalPct) || notaFiscalPct < 0) {
      throw new BadRequestException('notaFiscalPct inválido.');
    }
    const clientId = writeClientId(session, input.clientId);
    if (!isCollosRole(session.role) && clientId === null) {
      throw new ForbiddenException('Sem tenant válido para gravar a configuração.');
    }
    return this.database.upsertReportSettings({ clientId, notaFiscalPct });
  }
}

// --- helpers ----------------------------------------------------------------

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const messageRefDate = (message: CampaignMessageRecord): string =>
  message.sentAt ?? message.createdAt;

const campaignRefDate = (campaign: CampaignRecord, to: string | null): string =>
  campaign.finishedAt ?? campaign.startedAt ?? to ?? nowIso();

/** `from` date-only vira início do dia; ISO completo passa direto. */
const normalizeFromBound = (value?: string | null): string | null => {
  const raw = (value ?? '').trim();
  if (!raw) {
    return null;
  }
  return raw.length === 10 ? `${raw}T00:00:00.000Z` : raw;
};

/** `to` date-only vira fim do dia (inclusivo); ISO completo passa direto. */
const normalizeToBound = (value?: string | null): string | null => {
  const raw = (value ?? '').trim();
  if (!raw) {
    return null;
  }
  return raw.length === 10 ? `${raw}T23:59:59.999Z` : raw;
};

const emptyBuckets = (): SendBuckets => ({
  pending: 0,
  accepted: 0,
  sent: 0,
  delivered: 0,
  read: 0,
  failed: 0,
  total: 0,
});

const buildSendBuckets = (messages: CampaignMessageRecord[]): SendBuckets => {
  const buckets = emptyBuckets();
  for (const message of messages) {
    buckets.total += 1;
    if (message.status in buckets) {
      (buckets as unknown as Record<string, number>)[message.status] += 1;
    }
  }
  return buckets;
};

const addBuckets = (target: SendBuckets, source: SendBuckets): void => {
  target.pending += source.pending;
  target.accepted += source.accepted;
  target.sent += source.sent;
  target.delivered += source.delivered;
  target.read += source.read;
  target.failed += source.failed;
  target.total += source.total;
};

/** Baldes por status ATUAL (compatível com CampaignSummary) p/ campaignFunnel. */
const buildSummary = (messages: CampaignMessageRecord[]): CampaignRecord['summary'] => {
  const summary: CampaignRecord['summary'] = {
    total: 0,
    pending: 0,
    accepted: 0,
    sent: 0,
    delivered: 0,
    read: 0,
    failed: 0,
    skipped: 0,
  };
  for (const message of messages) {
    summary.total += 1;
    if (message.status in summary) {
      (summary as unknown as Record<string, number>)[message.status] += 1;
    }
  }
  return summary;
};

const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const brl = (value: number): string =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);

const renderReportHtml = (report: Awaited<ReturnType<ReportsService['campaignsReport']>>): string => {
  const periodLabel = `${report.period.from ?? 'início'} — ${report.period.to ?? 'hoje'}`;
  const rows = report.campaigns
    .map(
      (campaign) => `
        <tr>
          <td>${escapeHtml(campaign.name)}</td>
          <td>${escapeHtml(campaign.status)}</td>
          <td class="num">${campaign.sends.total}</td>
          <td class="num">${campaign.funnel.deliveredTotal}</td>
          <td class="num">${campaign.funnel.readTotal}</td>
          <td class="num">${campaign.sends.failed}</td>
          <td class="num">${campaign.cost.billableTotal}</td>
          <td class="num">${brl(campaign.cost.subtotalBrl)}</td>
          <td class="num">${brl(campaign.cost.notaFiscalValorBrl)}</td>
          <td class="num">${brl(campaign.cost.totalBrl)}${campaign.cost.hasMissingRate ? ' <span class="warn">*</span>' : ''}</td>
        </tr>`,
    )
    .join('');

  const totals = report.totals;
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>Relatório de campanhas — ${escapeHtml(periodLabel)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; color: #1a1a1a; margin: 32px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #555; font-size: 12px; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border-bottom: 1px solid #ddd; padding: 6px 8px; text-align: left; }
  th { background: #f3f3f3; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { font-weight: 600; border-top: 2px solid #333; }
  .warn { color: #b26a00; }
  .footnote { margin-top: 16px; font-size: 11px; color: #777; }
  @media print { body { margin: 0; } .noprint { display: none; } }
</style>
</head>
<body>
  <h1>Relatório de campanhas</h1>
  <div class="meta">
    Período: ${escapeHtml(periodLabel)} &middot; Tenant: ${escapeHtml(report.clientId ?? 'todos')}
    &middot; Gerado em ${escapeHtml(report.generatedAt)} &middot; NF: ${totals.notaFiscalPct}%
  </div>
  <p class="noprint" style="font-size:12px;color:#555">Use Ctrl/Cmd+P para salvar como PDF.</p>
  <table>
    <thead>
      <tr>
        <th>Campanha</th><th>Status</th><th class="num">Envios</th><th class="num">Entregues</th>
        <th class="num">Lidas</th><th class="num">Falhas</th><th class="num">Cobráveis</th>
        <th class="num">Subtotal</th><th class="num">NF</th><th class="num">Total</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr>
        <td>TOTAL (${totals.campaigns})</td><td></td>
        <td class="num">${totals.sends.total}</td>
        <td class="num">${totals.sends.delivered}</td>
        <td class="num">${totals.sends.read}</td>
        <td class="num">${totals.sends.failed}</td>
        <td class="num">${totals.billableTotal}</td>
        <td class="num">${brl(totals.subtotalBrl)}</td>
        <td class="num">${brl(totals.notaFiscalValorBrl)}</td>
        <td class="num">${brl(totals.totalBrl)}</td>
      </tr>
    </tfoot>
  </table>
  ${totals.hasMissingRate ? '<p class="footnote">* Há categorias sem tarifa cadastrada; custo dessas mensagens contabilizado como R$ 0,00.</p>' : ''}
</body>
</html>`;
};
