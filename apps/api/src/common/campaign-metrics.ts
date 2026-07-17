import { CampaignRecord } from '../database/types';

export type CampaignSummary = CampaignRecord['summary'];

export interface CampaignFunnel {
  total: number;
  pending: number;
  accepted: number;
  /** Enviadas (acumulado): saiu para a Meta e não falhou. */
  sentTotal: number;
  /** Entregues (acumulado): confirmada no aparelho. */
  deliveredTotal: number;
  /** Lidas. Balde terminal — já é acumulado por definição. */
  readTotal: number;
  failed: number;
  skipped: number;
  /** deliveredTotal / total em %, 1 casa. 0 quando total = 0. */
  deliveryRate: number;
  /** readTotal / total em %, 1 casa. 0 quando total = 0. */
  readRate: number;
}

/**
 * Converte os baldes de `campaign.summary` em métricas de FUNIL (acumuladas).
 *
 * Por que a derivação é essa:
 * `summary` vem de `getCampaignMessageSummaryInDatabase` (database.service.ts),
 * que é um `GROUP BY status` sobre `campaign_messages` — ou seja, baldes
 * MUTUAMENTE EXCLUDENTES do status ATUAL de cada mensagem. Uma mensagem lida
 * está SOMENTE em `read`: ela já saiu de `sent` e de `delivered`. Ler esses
 * baldes com rótulo de funil ("Entregues", "Enviadas") subconta o funil e chega
 * a produzir "Entregues 137 < Lidas 216" na mesma campanha.
 *
 * Assumindo o avanço esperado (accepted -> sent -> delivered -> read), o
 * acumulado de cada etapa é a soma do próprio balde com os baldes posteriores:
 *   sent      = sent + delivered + read
 *   delivered = delivered + read
 *   read      = read
 * `failed` e `skipped` são terminais e saem do funil; não entram no acumulado.
 *
 * LIMITE CONHECIDO (piso, não valor exato): o status NÃO é monotônico hoje.
 * `webhooks.service.ts:64` sobrescreve o status com o do último webhook, sem
 * guarda de regressão, e a Meta entrega eventos fora de ordem — um `delivered`
 * atrasado rebaixa uma mensagem já `read` de volta para `delivered`. Em produção
 * isso deixa milhares de mensagens com `readAt` carimbado num balde anterior, e
 * o funil derivado dos baldes SUBCONTA em relação aos timestamps
 * (`deliveredAt`/`readAt`), que são aditivos e nunca são limpos.
 * Consequência: este funil é o melhor número disponível a partir de `summary`
 * e corrige as inversões "entregues < lidas", mas deve ser lido como PISO.
 * A correção de raiz é guarda de monotonia no webhook + backfill, ou contagem
 * por timestamp. Ver relatório do bug de métrica.
 *
 * Deliberadamente NÃO alteramos o shape/semântica de `summary`: `pending` e
 * `failed` governam a transição de status da campanha em `refreshCampaignSummary`
 * (campaigns.service.ts) e mudá-los exigiria backfill do app_state. O funil é
 * derivado em leitura, a partir do que já está persistido.
 */
export const campaignFunnel = (summary: CampaignSummary): CampaignFunnel => {
  const total = summary.total;
  const readTotal = summary.read;
  const deliveredTotal = summary.delivered + readTotal;
  const sentTotal = summary.sent + deliveredTotal;
  const rate = (value: number): number => (total ? Number(((value / total) * 100).toFixed(1)) : 0);

  return {
    total,
    pending: summary.pending,
    accepted: summary.accepted,
    sentTotal,
    deliveredTotal,
    readTotal,
    failed: summary.failed,
    skipped: summary.skipped,
    deliveryRate: rate(deliveredTotal),
    readRate: rate(readTotal),
  };
};

/** Soma baldes de várias campanhas antes de derivar o funil do conjunto. */
export const sumCampaignSummaries = (summaries: CampaignSummary[]): CampaignSummary =>
  summaries.reduce<CampaignSummary>(
    (acc, summary) => ({
      total: acc.total + summary.total,
      pending: acc.pending + summary.pending,
      accepted: acc.accepted + summary.accepted,
      sent: acc.sent + summary.sent,
      delivered: acc.delivered + summary.delivered,
      read: acc.read + summary.read,
      failed: acc.failed + summary.failed,
      skipped: acc.skipped + summary.skipped,
    }),
    { total: 0, pending: 0, accepted: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 },
  );
