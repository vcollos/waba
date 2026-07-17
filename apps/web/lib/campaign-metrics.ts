/**
 * Contrato das métricas de campanha servidas por `/campaigns`.
 * Espelha `apps/api/src/common/campaign-metrics.ts` — fonte única no front,
 * para não duplicar (e não divergir) a interpretação de `summary` vs `funnel`.
 */

/**
 * Baldes por status ATUAL de cada mensagem — mutuamente excludentes.
 * Uma mensagem lida está SOMENTE em `read` (já saiu de `sent` e `delivered`).
 * Nunca exibir estes campos com rótulo de funil: produz "Entregues < Lidas".
 * Para rótulos de funil use `CampaignFunnel` (acumulado, derivado no backend).
 */
export interface CampaignSummary {
  total: number;
  pending: number;
  accepted: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
}

/** Funil acumulado: sentTotal = sent+delivered+read, deliveredTotal = delivered+read. */
export interface CampaignFunnel {
  total: number;
  pending: number;
  accepted: number;
  sentTotal: number;
  deliveredTotal: number;
  readTotal: number;
  failed: number;
  skipped: number;
  /** % sobre o total, 1 casa. */
  deliveryRate: number;
  readRate: number;
}

/**
 * Agregado de funil para N campanhas.
 *
 * Somar `funnel.sentTotal` de cada campanha equivale a somar os baldes de
 * `summary` e só então derivar o funil (a derivação é linear nos baldes), que é
 * o que `sumCampaignSummaries` + `campaignFunnel` fazem no backend. Por isso a
 * agregação no cliente pode partir direto do `funnel` já servido.
 */
export interface CampaignFunnelTotals {
  accepted: number;
  sentTotal: number;
  deliveredTotal: number;
  readTotal: number;
  failed: number;
  campaigns: number;
}

export const zeroFunnelTotals = (): CampaignFunnelTotals => ({
  accepted: 0,
  sentTotal: 0,
  deliveredTotal: 0,
  readTotal: 0,
  failed: 0,
  campaigns: 0,
});

/** Acumula (in-place) o funil de uma campanha no agregado. */
export const addFunnel = (acc: CampaignFunnelTotals, funnel: CampaignFunnel): void => {
  acc.accepted += funnel.accepted;
  acc.sentTotal += funnel.sentTotal;
  acc.deliveredTotal += funnel.deliveredTotal;
  acc.readTotal += funnel.readTotal;
  acc.failed += funnel.failed;
  acc.campaigns += 1;
};
