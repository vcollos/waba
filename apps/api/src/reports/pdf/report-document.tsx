import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import type { CampaignsReport } from '../reports.service';
import { logo } from './assets';
import {
  formatBrl,
  formatDateBr,
  formatDateTimeBr,
  formatInt,
  formatPercent,
} from './format';

/**
 * Documento PDF do relatório de custos de campanhas (WABA-25).
 *
 * Reproduz o layout-alvo `Relatorio Fatura WABA.dc.html`: A4 retrato, margem
 * ~14mm, cabeçalho/rodapé corridos (react-pdf `fixed`), estética chapada.
 * NÃO recalcula os 8 indicadores do topo (regra crítica do handoff): exibe os
 * valores como vêm do payload e mantém a frase de reconciliação nas seções 01 e 05.
 */

// --- tokens de cor (chapado, sem sombra/degradê) ----------------------------
const C = {
  ink: '#262626',
  secondary: '#5A5A57',
  mute: '#807F79',
  line: '#E4E3DC',
  lineStrong: '#CFCEC6',
  paper: '#FAFAF7',
  surface: '#FFFFFF',
  sunken: '#F2F2EB',
  green: '#3F7D58',
  red: '#B23A2E',
  stone: '#A6A59F',
} as const;

const F = { sans: 'Manrope', mono: 'IBMPlexMono' } as const;

export interface ReportDocumentProps {
  report: CampaignsReport;
  /** Nome da organização destinatária já resolvido pelo service. */
  recipientName: string;
  /** CNPJ do destinatário quando cadastrado; null -> placeholder. */
  recipientCnpj: string | null;
  mostrarGlossario: boolean;
  mostrarIds: boolean;
}

const styles = StyleSheet.create({
  page: {
    paddingTop: 64,
    paddingBottom: 52,
    paddingHorizontal: 40,
    backgroundColor: C.surface,
    color: C.ink,
    fontFamily: F.sans,
    fontSize: 9,
  },

  // header / footer corridos
  header: {
    position: 'absolute',
    top: 26,
    left: 40,
    right: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: C.line,
  },
  wordmark: { fontFamily: F.sans, fontWeight: 800, fontSize: 15, color: C.ink },
  headerLabel: {
    fontFamily: F.sans,
    fontWeight: 600,
    fontSize: 7.5,
    letterSpacing: 1.4,
    color: C.mute,
  },
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 40,
    right: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: C.line,
  },
  footerText: { fontFamily: F.mono, fontSize: 7, color: C.mute },

  // masthead
  masthead: { flexDirection: 'row', justifyContent: 'space-between', gap: 20 },
  mastheadLeft: { width: '60%' },
  eyebrow: {
    fontFamily: F.sans,
    fontWeight: 600,
    fontSize: 8,
    letterSpacing: 0.9,
    color: C.mute,
    marginBottom: 8,
  },
  title: {
    fontFamily: F.sans,
    fontWeight: 800,
    fontSize: 22,
    lineHeight: 1.05,
    color: C.ink,
    marginBottom: 7,
  },
  lede: { fontFamily: F.sans, fontSize: 9.5, lineHeight: 1.5, color: C.secondary },
  totalBox: {
    width: '36%',
    backgroundColor: C.ink,
    borderRadius: 12,
    padding: 14,
  },
  totalBoxLabel: {
    fontFamily: F.sans,
    fontWeight: 600,
    fontSize: 7.5,
    letterSpacing: 1.3,
    color: C.stone,
    marginBottom: 5,
  },
  totalBoxValue: {
    fontFamily: F.sans,
    fontWeight: 800,
    fontSize: 24,
    color: C.sunken,
    marginBottom: 10,
  },
  totalBoxRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
    borderTopWidth: 1,
    borderTopColor: 'rgba(242,242,235,0.16)',
  },
  totalBoxRowText: { fontFamily: F.mono, fontSize: 8, color: C.lineStrong },

  // parties
  parties: {
    flexDirection: 'row',
    marginTop: 16,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 12,
    overflow: 'hidden',
  },
  party: {
    width: '25%',
    backgroundColor: C.surface,
    padding: 11,
    borderLeftWidth: 1,
    borderLeftColor: C.line,
  },
  partyLabel: {
    fontFamily: F.sans,
    fontWeight: 600,
    fontSize: 7,
    letterSpacing: 0.9,
    color: C.mute,
    marginBottom: 5,
  },
  partyName: { fontFamily: F.sans, fontWeight: 700, fontSize: 9.5, color: C.ink, lineHeight: 1.35 },
  partyMono: { fontFamily: F.mono, fontSize: 7.5, color: C.secondary, marginTop: 2 },
  partyMuteMono: { fontFamily: F.mono, fontSize: 7.5, color: C.mute, marginTop: 2 },

  // section header
  sectionHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 20, marginBottom: 10 },
  sectionNum: { fontFamily: F.mono, fontWeight: 600, fontSize: 10, color: C.stone },
  sectionTitle: { fontFamily: F.sans, fontWeight: 700, fontSize: 13, color: C.ink },

  // tiles
  tileRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  tile: {
    width: '24%',
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 10,
    padding: 11,
    marginBottom: 8,
  },
  tileDark: { backgroundColor: C.ink, borderColor: C.ink },
  tileLabel: {
    fontFamily: F.sans,
    fontWeight: 600,
    fontSize: 7.5,
    letterSpacing: 0.7,
    color: C.mute,
  },
  tileLabelDark: { color: C.stone },
  tileValue: { fontFamily: F.sans, fontWeight: 800, fontSize: 19, color: C.ink, marginTop: 5 },
  tileValueMoney: { fontSize: 16 },
  tileValueDark: { color: C.sunken },
  tileCaption: { fontFamily: F.sans, fontSize: 7.5, color: C.mute, marginTop: 3 },
  tileCaptionDark: { color: C.stone },

  reconcile: { fontFamily: F.sans, fontSize: 7.5, lineHeight: 1.5, color: C.mute, marginTop: 8 },

  // glossary
  glossaryGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  glossaryCard: {
    width: '49%',
    flexDirection: 'row',
    gap: 10,
    backgroundColor: C.paper,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 8,
    padding: 10,
    marginBottom: 7,
  },
  glossaryTerm: { width: 72, fontFamily: F.sans, fontWeight: 700, fontSize: 8.5, color: C.ink },
  glossaryText: { flex: 1, fontFamily: F.sans, fontSize: 8, lineHeight: 1.45, color: C.secondary },

  // bars
  legend: { flexDirection: 'row', gap: 16, marginLeft: 26, marginBottom: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendSwatch: { width: 8, height: 8, borderRadius: 2 },
  legendText: { fontFamily: F.sans, fontSize: 8, color: C.secondary },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 9 },
  barLabel: { width: 130, fontFamily: F.sans, fontWeight: 600, fontSize: 8.5, color: C.ink, lineHeight: 1.2 },
  barPair: { flex: 1 },
  barLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  barTrack: { flex: 1, height: 6, backgroundColor: C.line, borderRadius: 3, overflow: 'hidden' },
  barFill: { height: 6, borderRadius: 3 },
  barPct: { fontFamily: F.mono, fontSize: 7.5, color: C.secondary, width: 34, textAlign: 'right' },

  // tables (generic)
  table: { borderWidth: 1, borderColor: C.line, borderRadius: 10, overflow: 'hidden' },
  theadRow: { flexDirection: 'row', backgroundColor: C.sunken },
  th: {
    fontFamily: F.sans,
    fontWeight: 600,
    fontSize: 7,
    letterSpacing: 0.5,
    color: C.mute,
    paddingVertical: 7,
    paddingHorizontal: 8,
  },
  trow: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.line },
  td: { fontFamily: F.sans, fontSize: 9, color: C.ink, paddingVertical: 8, paddingHorizontal: 8 },
  tdMono: { fontFamily: F.mono, fontSize: 8.5, color: C.ink, paddingVertical: 8, paddingHorizontal: 8 },

  // observações
  obsBox: {
    marginTop: 20,
    backgroundColor: C.paper,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 12,
    padding: 14,
  },
  obsItem: { flexDirection: 'row', gap: 6, marginBottom: 5 },
  obsBullet: { fontFamily: F.sans, fontSize: 8.5, color: C.mute },
  obsText: { flex: 1, fontFamily: F.sans, fontSize: 8.5, lineHeight: 1.55, color: C.secondary },
});

// larguras (pt) das colunas da tabela 05 (Campanha usa flexGrow p/ o resto)
const COL = { periodo: 56, num: 30, falhas: 32, money: 50, nf: 40 } as const;

const clampPct = (value: number): number => Math.max(0, Math.min(100, value));

const GLOSSARY: Array<[string, string]> = [
  ['Envios totais', 'Mensagens que o sistema tentou disparar no período, somando todas as campanhas.'],
  ['Entregues', 'Mensagens que chegaram ao aparelho do destinatário — os dois tiques cinza do WhatsApp.'],
  ['Lidas', 'Mensagens abertas pelo destinatário — os dois tiques azuis do WhatsApp.'],
  ['Falhas', 'Tentativas não entregues (número inválido, bloqueio, janela fechada). Não são cobradas.'],
  ['Cobráveis', 'Somente as mensagens tarifadas pela Meta/WhatsApp. É a base do cálculo financeiro.'],
  ['Subtotal', 'Cobráveis × tarifa unitária da categoria. É o custo dos disparos antes de impostos.'],
  ['Nota fiscal', 'Repasse do valor da NF-e emitida sobre o serviço, sobre o subtotal.'],
  ['Total', 'Subtotal + nota fiscal. É o valor final do período.'],
];

const Header = () => (
  <View style={styles.header} fixed>
    {logo.png ? (
      <Image src={logo.png} style={{ height: 16 }} />
    ) : (
      <Text style={styles.wordmark}>Collos</Text>
    )}
    <Text style={styles.headerLabel}>RELATÓRIO DE CUSTOS · WABA COLLOS</Text>
  </View>
);

const Footer = () => (
  <View style={styles.footer} fixed>
    <Text style={styles.footerText}>Collos Ltda · CNPJ 26.610.148/0001-31</Text>
    <Text style={styles.footerText}>Documento gerado automaticamente pelo WABA Collos</Text>
  </View>
);

const SectionHead = ({ num, title, flush }: { num: string; title: string; flush?: boolean }) => (
  <View style={flush ? [styles.sectionHead, { marginTop: 0, marginBottom: 8 }] : styles.sectionHead}>
    <Text style={styles.sectionNum}>{num}</Text>
    <Text style={styles.sectionTitle}>{title}</Text>
  </View>
);

interface TileProps {
  label: string;
  value: string;
  caption: string;
  money?: boolean;
  dark?: boolean;
}
const Tile = ({ label, value, caption, money, dark }: TileProps) => (
  <View style={dark ? [styles.tile, styles.tileDark] : styles.tile}>
    <Text style={dark ? [styles.tileLabel, styles.tileLabelDark] : styles.tileLabel}>{label}</Text>
    <Text
      style={[
        styles.tileValue,
        ...(money ? [styles.tileValueMoney] : []),
        ...(dark ? [styles.tileValueDark] : []),
      ]}
    >
      {value}
    </Text>
    <Text style={dark ? [styles.tileCaption, styles.tileCaptionDark] : styles.tileCaption}>
      {caption}
    </Text>
  </View>
);

export function ReportDocument({
  report,
  recipientName,
  recipientCnpj,
  mostrarGlossario,
  mostrarIds,
}: ReportDocumentProps) {
  const t = report.totals;
  const nfPct = t.notaFiscalPct;

  const periodStart = formatDateBr(report.period.from);
  const periodEnd = formatDateBr(report.period.to);
  const periodLabel =
    report.period.from || report.period.to
      ? `Período ${periodStart} a ${periodEnd}`
      : 'Período completo da conta';
  const emissionDate = formatDateBr(report.generatedAt);

  // Caption do tile Subtotal: só quando há categoria única com tarifa cadastrada.
  const singleCategory =
    t.billableByCategory.length === 1 && t.billableByCategory[0].unitPriceBrl != null
      ? t.billableByCategory[0]
      : null;
  const subtotalCaption = singleCategory
    ? `${formatInt(t.billableTotal)} × ${formatBrl(singleCategory.unitPriceBrl as number)}`
    : 'cobráveis × tarifa por categoria';

  // Barras: só campanhas com algum envio — 0/0 = 0% não agrega e polui a seção.
  const barCampaigns = report.campaigns.filter((campaign) => campaign.sends.total > 0);

  return (
    <Document
      title={`Relatório de custos — ${recipientName}`}
      author="WABA Collos"
      creator="WABA Collos"
      producer="WABA Collos"
    >
      <Page size="A4" style={styles.page}>
        <Header />
        <Footer />

        {/* MASTHEAD */}
        <View style={styles.masthead}>
          <View style={styles.mastheadLeft}>
            <Text style={styles.eyebrow}>{`Relatório de custos · ${periodLabel}`}</Text>
            <Text style={styles.title}>Envios via WhatsApp Business API</Text>
            <Text style={styles.lede}>
              Consolidação das campanhas disparadas no período, com volumes, tarifas e nota
              fiscal. Somente mensagens cobráveis compõem o valor financeiro.
            </Text>
          </View>
          <View style={styles.totalBox}>
            <Text style={styles.totalBoxLabel}>TOTAL DO PERÍODO</Text>
            <Text style={styles.totalBoxValue}>{formatBrl(t.totalBrl)}</Text>
            <View style={styles.totalBoxRow}>
              <Text style={styles.totalBoxRowText}>Subtotal (disparos)</Text>
              <Text style={styles.totalBoxRowText}>{formatBrl(t.subtotalBrl)}</Text>
            </View>
            <View style={styles.totalBoxRow}>
              <Text style={styles.totalBoxRowText}>{`Nota fiscal (${nfPct}%)`}</Text>
              <Text style={styles.totalBoxRowText}>{formatBrl(t.notaFiscalValorBrl)}</Text>
            </View>
          </View>
        </View>

        {/* PARTES */}
        <View style={styles.parties}>
          <View style={[styles.party, { borderLeftWidth: 0 }]}>
            <Text style={styles.partyLabel}>EMITENTE</Text>
            <Text style={styles.partyName}>Collos Ltda</Text>
            <Text style={styles.partyMono}>CNPJ 26.610.148/0001-31</Text>
            <Text style={styles.partyMono}>Pix: financeiro@collos.com.br</Text>
          </View>
          <View style={styles.party}>
            <Text style={styles.partyLabel}>DESTINATÁRIO</Text>
            <Text style={styles.partyName}>{recipientName}</Text>
            <Text style={styles.partyMuteMono}>
              {recipientCnpj ? `CNPJ ${recipientCnpj}` : 'CNPJ conforme cadastro'}
            </Text>
            <Text style={styles.partyMuteMono}>Departamento financeiro</Text>
          </View>
          <View style={styles.party}>
            <Text style={styles.partyLabel}>PERÍODO</Text>
            <Text style={styles.partyName}>{periodStart}</Text>
            <Text style={styles.partyName}>{`a ${periodEnd}`}</Text>
          </View>
          <View style={styles.party}>
            <Text style={styles.partyLabel}>EMISSÃO</Text>
            <Text style={styles.partyName}>{emissionDate}</Text>
            <Text style={styles.partyMono}>{`${t.campaigns} campanha(s)`}</Text>
          </View>
        </View>

        {/* 01 RESUMO */}
        <SectionHead num="01" title="Resumo executivo" />
        <View style={styles.tileRow}>
          <Tile label="Envios totais" value={formatInt(t.sends.total)} caption="tentativas de disparo" />
          <Tile label="Entregues" value={formatInt(t.sends.delivered)} caption="chegaram ao aparelho" />
          <Tile label="Lidas" value={formatInt(t.sends.read)} caption="abertas pelo destinatário" />
          <Tile label="Falhas" value={formatInt(t.sends.failed)} caption="não cobradas" />
          <Tile label="Cobráveis" value={formatInt(t.billableTotal)} caption="base da cobrança" />
          <Tile label="Subtotal" value={formatBrl(t.subtotalBrl)} caption={subtotalCaption} money />
          <Tile
            label="Nota fiscal"
            value={formatBrl(t.notaFiscalValorBrl)}
            caption={`${nfPct}% sobre o subtotal`}
            money
          />
          <Tile label="Total" value={formatBrl(t.totalBrl)} caption="subtotal + nota fiscal" money dark />
        </View>
        <Text style={styles.reconcile}>
          Os indicadores acima consideram todo o período da conta. A cobrança recai apenas
          sobre as mensagens <Text style={{ color: C.secondary, fontWeight: 700 }}>cobráveis</Text>
          {' '}— falhas e mensagens de teste não geram custo.
        </Text>

        {/* 02 GLOSSÁRIO */}
        {mostrarGlossario ? (
          <View wrap={false}>
            <SectionHead num="02" title="O que cada número significa" />
            <View style={styles.glossaryGrid}>
              {GLOSSARY.map(([term, text]) => (
                <View key={term} style={styles.glossaryCard}>
                  <Text style={styles.glossaryTerm}>{term}</Text>
                  <Text style={styles.glossaryText}>{text}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* 03 BARRAS */}
        <View>
          <SectionHead num="03" title="Entrega e leitura por campanha" />
          <View style={styles.legend}>
            <View style={styles.legendItem}>
              <View style={[styles.legendSwatch, { backgroundColor: C.green }]} />
              <Text style={styles.legendText}>Taxa de entrega</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendSwatch, { backgroundColor: C.ink }]} />
              <Text style={styles.legendText}>Taxa de leitura</Text>
            </View>
          </View>
          {barCampaigns.map((campaign) => (
            <View key={campaign.campaignId} style={styles.barRow} wrap={false}>
              <Text style={styles.barLabel}>{campaign.name}</Text>
              <View style={styles.barPair}>
                <View style={[styles.barLine, { marginBottom: 4 }]}>
                  <View style={styles.barTrack}>
                    <View
                      style={[
                        styles.barFill,
                        { width: `${clampPct(campaign.funnel.deliveryRate)}%`, backgroundColor: C.green },
                      ]}
                    />
                  </View>
                  <Text style={styles.barPct}>{formatPercent(campaign.funnel.deliveryRate)}</Text>
                </View>
                <View style={styles.barLine}>
                  <View style={styles.barTrack}>
                    <View
                      style={[
                        styles.barFill,
                        { width: `${clampPct(campaign.funnel.readRate)}%`, backgroundColor: C.ink },
                      ]}
                    />
                  </View>
                  <Text style={styles.barPct}>{formatPercent(campaign.funnel.readRate)}</Text>
                </View>
              </View>
            </View>
          ))}
        </View>

        {/* 04 CATEGORIA */}
        <View wrap={false}>
          <SectionHead num="04" title="Cobráveis por categoria" />
          <View style={styles.table}>
            <View style={styles.theadRow}>
              <Text style={[styles.th, { flexGrow: 1 }]}>CATEGORIA</Text>
              <Text style={[styles.th, { width: 80, textAlign: 'right' }]}>COBRÁVEIS</Text>
              <Text style={[styles.th, { width: 90, textAlign: 'right' }]}>TARIFA UNITÁRIA</Text>
              <Text style={[styles.th, { width: 90, textAlign: 'right' }]}>SUBTOTAL</Text>
            </View>
            {t.billableByCategory.map((line) => (
              <View key={line.category} style={styles.trow}>
                <Text style={[styles.td, { flexGrow: 1, fontWeight: 600 }]}>{line.category}</Text>
                <Text style={[styles.tdMono, { width: 80, textAlign: 'right' }]}>
                  {formatInt(line.billableCount)}
                </Text>
                <Text style={[styles.tdMono, { width: 90, textAlign: 'right' }]}>
                  {line.unitPriceBrl != null ? formatBrl(line.unitPriceBrl) : '—'}
                </Text>
                <Text style={[styles.tdMono, { width: 90, textAlign: 'right' }]}>
                  {formatBrl(line.subtotalBrl)}
                </Text>
              </View>
            ))}
          </View>
        </View>

        {/* 05 CAMPANHAS */}
        <View>
          <SectionHead num="05" title="Custo por campanha" />
          <View style={styles.table}>
            <View style={styles.theadRow}>
              <Text style={[styles.th, { flexGrow: 1 }]}>CAMPANHA</Text>
              <Text style={[styles.th, { width: COL.periodo }]}>PERÍODO</Text>
              <Text style={[styles.th, { width: COL.num, textAlign: 'right' }]}>ENV.</Text>
              <Text style={[styles.th, { width: COL.num, textAlign: 'right' }]}>ENTR.</Text>
              <Text style={[styles.th, { width: COL.num, textAlign: 'right' }]}>LIDAS</Text>
              <Text style={[styles.th, { width: COL.falhas, textAlign: 'right' }]}>FALHAS</Text>
              <Text style={[styles.th, { width: COL.falhas, textAlign: 'right' }]}>COBR.</Text>
              <Text style={[styles.th, { width: COL.money, textAlign: 'right' }]}>SUBTOTAL</Text>
              <Text style={[styles.th, { width: COL.nf, textAlign: 'right' }]}>NF</Text>
              <Text style={[styles.th, { width: COL.money, textAlign: 'right' }]}>TOTAL</Text>
            </View>
            {report.campaigns.map((campaign) => (
              <View key={campaign.campaignId} style={styles.trow} wrap={false}>
                <View style={{ flexGrow: 1, paddingVertical: 7, paddingHorizontal: 8 }}>
                  <Text style={{ fontFamily: F.sans, fontWeight: 600, fontSize: 8.5, color: C.ink }}>
                    {campaign.name}
                  </Text>
                  {mostrarIds ? (
                    <Text style={{ fontFamily: F.mono, fontSize: 6, color: C.stone, marginTop: 2 }}>
                      {campaign.campaignId}
                    </Text>
                  ) : null}
                </View>
                <Text
                  style={{
                    width: COL.periodo,
                    fontFamily: F.mono,
                    fontSize: 6.5,
                    color: C.secondary,
                    paddingVertical: 7,
                    paddingHorizontal: 6,
                  }}
                >
                  {`${formatDateTimeBr(campaign.startedAt)}\n→ ${formatDateTimeBr(campaign.finishedAt)}`}
                </Text>
                <Text style={[styles.tdMono, { width: COL.num, textAlign: 'right', fontSize: 7.5 }]}>
                  {formatInt(campaign.sends.total)}
                </Text>
                <Text style={[styles.tdMono, { width: COL.num, textAlign: 'right', fontSize: 7.5 }]}>
                  {formatInt(campaign.funnel.deliveredTotal)}
                </Text>
                <Text style={[styles.tdMono, { width: COL.num, textAlign: 'right', fontSize: 7.5 }]}>
                  {formatInt(campaign.funnel.readTotal)}
                </Text>
                <Text
                  style={[
                    styles.tdMono,
                    {
                      width: COL.falhas,
                      textAlign: 'right',
                      fontSize: 7.5,
                      color: campaign.sends.failed > 0 ? C.red : C.mute,
                    },
                  ]}
                >
                  {formatInt(campaign.sends.failed)}
                </Text>
                <Text style={[styles.tdMono, { width: COL.falhas, textAlign: 'right', fontSize: 7.5 }]}>
                  {formatInt(campaign.cost.billableTotal)}
                </Text>
                <Text style={[styles.tdMono, { width: COL.money, textAlign: 'right', fontSize: 7.5 }]}>
                  {formatBrl(campaign.cost.subtotalBrl)}
                </Text>
                <Text
                  style={[
                    styles.tdMono,
                    { width: COL.nf, textAlign: 'right', fontSize: 7.5, color: C.secondary },
                  ]}
                >
                  {formatBrl(campaign.cost.notaFiscalValorBrl)}
                </Text>
                <Text
                  style={[
                    styles.tdMono,
                    { width: COL.money, textAlign: 'right', fontSize: 7.5, fontWeight: 500 },
                  ]}
                >
                  {formatBrl(campaign.cost.totalBrl)}
                </Text>
              </View>
            ))}
            {/* linha de total */}
            <View
              style={[
                styles.trow,
                { borderTopWidth: 2, borderTopColor: C.lineStrong, backgroundColor: C.sunken },
              ]}
              wrap={false}
            >
              <Text
                style={{
                  flexGrow: 1,
                  fontFamily: F.sans,
                  fontWeight: 700,
                  fontSize: 8.5,
                  color: C.ink,
                  paddingVertical: 8,
                  paddingHorizontal: 8,
                }}
              >
                Total das campanhas cobradas
              </Text>
              <Text
                style={[styles.tdMono, { width: COL.falhas, textAlign: 'right', fontSize: 7.5, fontWeight: 600 }]}
              >
                {formatInt(t.billableTotal)}
              </Text>
              <Text
                style={[styles.tdMono, { width: COL.money, textAlign: 'right', fontSize: 7.5, fontWeight: 600 }]}
              >
                {formatBrl(t.subtotalBrl)}
              </Text>
              <Text
                style={[styles.tdMono, { width: COL.nf, textAlign: 'right', fontSize: 7.5, fontWeight: 600 }]}
              >
                {formatBrl(t.notaFiscalValorBrl)}
              </Text>
              <Text
                style={[styles.tdMono, { width: COL.money, textAlign: 'right', fontSize: 8, fontWeight: 700 }]}
              >
                {formatBrl(t.totalBrl)}
              </Text>
            </View>
          </View>
          <Text style={styles.reconcile}>
            Env. = enviadas · Entr. = entregues · Cobr. = cobráveis. Os indicadores do topo
            consideram todo o período da conta; esta tabela detalha apenas as campanhas que
            geraram cobrança.
          </Text>
        </View>

        {/* 06 OBSERVAÇÕES */}
        <View style={styles.obsBox} wrap={false}>
          <SectionHead num="06" title="Como calculamos · Observações" flush />
          {[
            'A cobrança segue o modelo de mensagens do WhatsApp Business Platform (Meta). Apenas mensagens cobráveis compõem o subtotal — falhas e testes internos não geram custo.',
            'Tarifa unitária conforme a categoria da mensagem vigente no período.',
            `Nota fiscal: repasse de ${nfPct}% referente à NF-e emitida sobre o serviço.`,
            'Valores em reais (R$), arredondados a duas casas. Pequenas diferenças de centavos decorrem de arredondamento por linha.',
            `Período de referência: ${periodStart} a ${periodEnd}. Documento gerado automaticamente pelo WABA Collos.`,
          ].map((text, index) => (
            <View key={index} style={styles.obsItem}>
              <Text style={styles.obsBullet}>·</Text>
              <Text style={styles.obsText}>{text}</Text>
            </View>
          ))}
        </View>
      </Page>
    </Document>
  );
}
