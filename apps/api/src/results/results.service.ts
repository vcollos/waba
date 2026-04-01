import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { FlowResponseRecord } from '../database/types';

@Injectable()
export class ResultsService {
  constructor(private readonly database: DatabaseService) {}

  async listFlowResponses(filters?: {
    campaignId?: string;
    flowCacheId?: string;
    contactId?: string;
    limit?: number;
  }) {
    const state = await this.database.readMetaSnapshot();
    const filteredResponses = state.flowResponses.filter((response) =>
      matchesFlowResponseFilters(response, filters),
    );
    const contactIds = [
      ...new Set(filteredResponses.map((response) => response.contactId).filter(isDefined)),
    ];
    const contactsById = await this.loadResultContactsByIds(contactIds);
    const campaignsById = new Map(state.campaigns.map((campaign) => [campaign.id, campaign]));
    const flowsById = new Map(state.flows.map((flow) => [flow.id, flow]));
    const flowsByMetaFlowId = new Map(
      state.flows.filter((flow) => flow.metaFlowId).map((flow) => [flow.metaFlowId!, flow]),
    );
    const templatesById = new Map(state.templates.map((template) => [template.id, template]));

    return filteredResponses
      .map((response) => {
        const campaign = response.campaignId
          ? campaignsById.get(response.campaignId) ?? null
          : null;
        const contact = response.contactId ? contactsById.get(response.contactId) ?? null : null;
        const flow = response.flowCacheId
          ? flowsById.get(response.flowCacheId) ?? null
          : response.metaFlowId
            ? flowsByMetaFlowId.get(response.metaFlowId) ?? null
            : null;
        const template = response.templateCacheId
          ? templatesById.get(response.templateCacheId) ?? null
          : null;

        return {
          id: response.id,
          completedAt: response.completedAt,
          responsePayload: response.responsePayload,
          campaignName: campaign?.name ?? null,
          contactName: contact?.name ?? null,
          contactPhone: contact?.phoneE164 ?? null,
          flowName: flow?.name ?? null,
          templateName: template?.name ?? null,
          detectedPayloadDefinitions: flow?.completionPayloadDefinitions ?? [],
        };
      })
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
      .slice(0, filters?.limit ?? 500);
  }

  async summary() {
    const state = await this.database.readMetaSnapshot();
    const totalResponses = state.flowResponses.length;
    const byFlow = new Map<string, number>();
    const byCampaign = new Map<string, number>();
    const byDay = new Map<string, number>();
    const fieldCoverage = new Map<string, number>();
    const categoricalValues = new Map<string, Map<string, number>>();
    const surveyFieldValues = new Map<string, number[]>();
    const operationTimeline = new Map<
      string,
      { accepted: number; sent: number; delivered: number; read: number; failed: number }
    >();
    const errorBreakdown = new Map<string, number>();
    const currentStatusCounts = new Map<string, number>();
    const campaignsById = new Map(state.campaigns.map((campaign) => [campaign.id, campaign]));
    const flowsById = new Map(state.flows.map((flow) => [flow.id, flow]));
    const flowsByMetaFlowId = new Map(
      state.flows.filter((flow) => flow.metaFlowId).map((flow) => [flow.metaFlowId!, flow]),
    );

    for (const response of state.flowResponses) {
      const campaign = response.campaignId ? campaignsById.get(response.campaignId) ?? null : null;
      const flow = response.flowCacheId
        ? flowsById.get(response.flowCacheId) ?? null
        : response.metaFlowId
          ? flowsByMetaFlowId.get(response.metaFlowId) ?? null
          : null;

      const flowKey = flow?.name ?? response.metaFlowId ?? 'Flow não identificado';
      byFlow.set(flowKey, (byFlow.get(flowKey) ?? 0) + 1);

      const campaignKey = campaign?.name ?? 'Sem campanha';
      byCampaign.set(campaignKey, (byCampaign.get(campaignKey) ?? 0) + 1);

      const dayKey = response.completedAt.slice(0, 10);
      byDay.set(dayKey, (byDay.get(dayKey) ?? 0) + 1);

      for (const [fieldKey, value] of Object.entries(response.responsePayload ?? {})) {
        fieldCoverage.set(fieldKey, (fieldCoverage.get(fieldKey) ?? 0) + 1);

        if (isCategoricalValue(value)) {
          const values = categoricalValues.get(fieldKey) ?? new Map<string, number>();
          const normalizedValue = normalizeCategoricalValue(value);
          values.set(normalizedValue, (values.get(normalizedValue) ?? 0) + 1);
          categoricalValues.set(fieldKey, values);
        }

        const numericValue = normalizeNumericSurveyValue(value);
        if (numericValue !== null) {
          const values = surveyFieldValues.get(fieldKey) ?? [];
          values.push(numericValue);
          surveyFieldValues.set(fieldKey, values);
        }
      }
    }

    for (const message of state.campaignMessages) {
      currentStatusCounts.set(message.status, (currentStatusCounts.get(message.status) ?? 0) + 1);

      incrementTimeline(operationTimeline, message.sentAt, 'sent');
      incrementTimeline(operationTimeline, message.deliveredAt, 'delivered');
      incrementTimeline(operationTimeline, message.readAt, 'read');
      incrementTimeline(operationTimeline, message.failedAt, 'failed');

      if (message.status === 'failed') {
        const errorLabel = [message.providerErrorCode, message.providerErrorTitle]
          .filter(Boolean)
          .join(' - ') || 'Falha não classificada';
        errorBreakdown.set(errorLabel, (errorBreakdown.get(errorLabel) ?? 0) + 1);
      }
    }

    for (const event of state.messageEvents) {
      if (event.eventType === 'send.accepted') {
        incrementTimeline(operationTimeline, event.occurredAt, 'accepted');
      }
    }

    const totalTrackedMessages = state.campaignMessages.length;
    const totalAcceptedMessages = state.campaignMessages.filter((message) => Boolean(message.providerMessageId)).length;
    const totalSentMessages = state.campaignMessages.filter((message) => Boolean(message.sentAt)).length;
    const totalDeliveredMessages = state.campaignMessages.filter((message) => Boolean(message.deliveredAt)).length;
    const totalReadMessages = state.campaignMessages.filter((message) => Boolean(message.readAt)).length;
    const totalFailedMessages = state.campaignMessages.filter((message) => message.status === 'failed').length;
    const totalPendingMessages = state.campaignMessages.filter((message) => message.status === 'pending').length;
    const totalProcessedMessages = totalTrackedMessages - totalPendingMessages;

    const statusDistribution = buildStatusDistribution(currentStatusCounts, totalTrackedMessages);
    const topDeliveryCampaigns = [...state.campaigns]
      .map((campaign) => {
        const total = campaign.summary.total;
        const pending = campaign.summary.pending;
        const processed = Math.max(total - pending, 0);
        const delivered = campaign.summary.delivered + campaign.summary.read;
        const read = campaign.summary.read;
        const failed = campaign.summary.failed;
        return {
          campaignId: campaign.id,
          campaignName: campaign.name,
          status: campaign.status,
          total,
          pending,
          processed,
          delivered,
          read,
          failed,
          successRate: total ? Number(((delivered / total) * 100).toFixed(1)) : 0,
          readRate: total ? Number(((read / total) * 100).toFixed(1)) : 0,
          failureRate: total ? Number(((failed / total) * 100).toFixed(1)) : 0,
        };
      })
      .filter((campaign) => campaign.total > 0)
      .sort((left, right) => right.processed - left.processed)
      .slice(0, 8);

    const surveyMetrics = buildSurveyMetrics(surveyFieldValues, fieldCoverage);

    return {
      totalFlowResponses: totalResponses,
      deliveryOverview: {
        totalTrackedMessages,
        totalProcessedMessages,
        totalAcceptedMessages,
        totalSentMessages,
        totalDeliveredMessages,
        totalReadMessages,
        totalFailedMessages,
        totalPendingMessages,
        successRate: totalTrackedMessages
          ? Number(((totalDeliveredMessages / totalTrackedMessages) * 100).toFixed(1))
          : 0,
        readRate: totalTrackedMessages
          ? Number(((totalReadMessages / totalTrackedMessages) * 100).toFixed(1))
          : 0,
        failureRate: totalTrackedMessages
          ? Number(((totalFailedMessages / totalTrackedMessages) * 100).toFixed(1))
          : 0,
      },
      statusDistribution,
      deliveryTimeline: [...operationTimeline.entries()]
        .map(([day, values]) => ({ day, ...values }))
        .sort((left, right) => left.day.localeCompare(right.day))
        .slice(-14),
      topDeliveryCampaigns,
      errorBreakdown: [...errorBreakdown.entries()]
        .map(([label, count]) => ({
          label,
          count,
          percentage: totalFailedMessages ? Number(((count / totalFailedMessages) * 100).toFixed(1)) : 0,
        }))
        .sort((left, right) => right.count - left.count)
        .slice(0, 8),
      byFlow: [...byFlow.entries()]
        .map(([flowName, count]) => ({
          flowName,
          count,
          percentage: totalResponses ? Number(((count / totalResponses) * 100).toFixed(1)) : 0,
        }))
        .sort((left, right) => right.count - left.count),
      byCampaign: [...byCampaign.entries()]
        .map(([campaignName, count]) => ({
          campaignName,
          count,
          percentage: totalResponses ? Number(((count / totalResponses) * 100).toFixed(1)) : 0,
        }))
        .sort((left, right) => right.count - left.count)
        .slice(0, 10),
      byDay: [...byDay.entries()]
        .map(([day, count]) => ({ day, count }))
        .sort((left, right) => left.day.localeCompare(right.day))
        .slice(-14),
      fieldCoverage: [...fieldCoverage.entries()]
        .map(([fieldKey, count]) => ({
          fieldKey,
          count,
          percentage: totalResponses ? Number(((count / totalResponses) * 100).toFixed(1)) : 0,
        }))
        .sort((left, right) => right.count - left.count)
        .slice(0, 12),
      categoricalDistributions: [...categoricalValues.entries()]
        .map(([fieldKey, values]) => ({
          fieldKey,
          totalResponses: [...values.values()].reduce((accumulator, count) => accumulator + count, 0),
          distinctValues: values.size,
          values: [...values.entries()]
            .map(([value, count]) => ({ value, count }))
            .sort((left, right) => right.count - left.count),
        }))
        .filter((item) => item.distinctValues >= 2 && item.distinctValues <= 12)
        .sort((left, right) => right.totalResponses - left.totalResponses)
        .slice(0, 6),
      surveyMetrics,
    };
  }

  private async loadResultContactsByIds(contactIds: string[]) {
    const uniqueIds = [...new Set(contactIds.filter(Boolean))];
    if (uniqueIds.length === 0) {
      return new Map<string, { id: string; name: string; phoneE164: string }>();
    }

    return this.database.execute((database) => {
      const placeholders = uniqueIds.map(() => '?').join(', ');
      const rows = database
        .prepare(
          `SELECT id, name, phone_e164
           FROM contacts
           WHERE id IN (${placeholders})`,
        )
        .all(...uniqueIds) as Array<Record<string, unknown>>;

      return new Map(
        rows.map((row) => [
          String(row.id),
          {
            id: String(row.id),
            name: String(row.name ?? ''),
            phoneE164: String(row.phone_e164 ?? ''),
          },
        ]),
      );
    });
  }
}

const matchesFlowResponseFilters = (
  response: FlowResponseRecord,
  filters?: {
    campaignId?: string;
    flowCacheId?: string;
    contactId?: string;
    limit?: number;
  },
) => {
  if (filters?.campaignId && response.campaignId !== filters.campaignId) {
    return false;
  }
  if (filters?.flowCacheId && response.flowCacheId !== filters.flowCacheId) {
    return false;
  }
  if (filters?.contactId && response.contactId !== filters.contactId) {
    return false;
  }
  return true;
};

const isDefined = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;

const incrementTimeline = (
  timeline: Map<string, { accepted: number; sent: number; delivered: number; read: number; failed: number }>,
  value: string | null | undefined,
  key: 'accepted' | 'sent' | 'delivered' | 'read' | 'failed',
) => {
  if (!value) {
    return;
  }

  const dayKey = value.slice(0, 10);
  const bucket = timeline.get(dayKey) ?? { accepted: 0, sent: 0, delivered: 0, read: 0, failed: 0 };
  bucket[key] += 1;
  timeline.set(dayKey, bucket);
};

const buildStatusDistribution = (counts: Map<string, number>, total: number) => {
  const order = [
    ['pending', 'Pendentes', 'warning'],
    ['accepted', 'Aceitas', 'neutral'],
    ['sent', 'Enviadas', 'neutral'],
    ['delivered', 'Entregues', 'success'],
    ['read', 'Lidas', 'success'],
    ['failed', 'Falhas', 'danger'],
    ['skipped', 'Ignoradas', 'warning'],
    ['cancelled', 'Canceladas', 'danger'],
  ] as const;

  return order
    .map(([status, label, tone]) => {
      const count = counts.get(status) ?? 0;
      return {
        status,
        label,
        count,
        tone,
        percentage: total ? Number(((count / total) * 100).toFixed(1)) : 0,
      };
    })
    .filter((item) => item.count > 0);
};

const isCategoricalValue = (value: unknown): value is string | number | boolean | null =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean';

const normalizeCategoricalValue = (value: string | number | boolean | null): string => {
  if (value === null) {
    return 'null';
  }

  return String(value);
};

type SurveyMetricSummary = {
  fieldKey: string;
  metricType: 'nps' | 'csat';
  label: string;
  totalResponses: number;
  validResponses: number;
  ignoredResponses: number;
  score: number;
  averageScore: number | null;
  distribution: Array<{ value: string; count: number; percentage: number }>;
  scoreLabel: string;
  scoreHint: string;
  segments: Array<{ label: string; count: number; percentage: number; tone: 'success' | 'warning' | 'danger' }>;
};

const buildSurveyMetrics = (
  fieldValues: Map<string, number[]>,
  fieldCoverage: Map<string, number>,
): SurveyMetricSummary[] => {
  const metrics: SurveyMetricSummary[] = [];

  for (const [fieldKey, values] of fieldValues.entries()) {
    const normalizedKey = fieldKey.trim().toLowerCase();

    if (normalizedKey.includes('nps')) {
      const metric = buildNpsMetric(fieldKey, values, fieldCoverage.get(fieldKey) ?? values.length);
      if (metric) {
        metrics.push(metric);
      }
      continue;
    }

    if (normalizedKey.includes('csat') || normalizedKey.includes('cesat')) {
      const metric = buildCsatMetric(fieldKey, values, fieldCoverage.get(fieldKey) ?? values.length);
      if (metric) {
        metrics.push(metric);
      }
    }
  }

  return metrics.sort((left, right) => {
    if (left.metricType !== right.metricType) {
      return left.metricType === 'nps' ? -1 : 1;
    }
    return right.validResponses - left.validResponses;
  });
};

const buildNpsMetric = (
  fieldKey: string,
  values: number[],
  totalResponses: number,
): SurveyMetricSummary | null => {
  const validValues = values.filter((value) => Number.isInteger(value) && value >= 0 && value <= 10);
  if (validValues.length === 0) {
    return null;
  }

  const counts = new Map<string, number>();
  for (let index = 0; index <= 10; index += 1) {
    counts.set(String(index), 0);
  }

  for (const value of validValues) {
    const key = String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const promoters = validValues.filter((value) => value >= 9).length;
  const passives = validValues.filter((value) => value >= 7 && value <= 8).length;
  const detractors = validValues.filter((value) => value <= 6).length;
  const total = validValues.length;
  const score = Number((((promoters / total) * 100) - ((detractors / total) * 100)).toFixed(1));

  return {
    fieldKey,
    metricType: 'nps',
    label: 'Net Promoter Score',
    totalResponses,
    validResponses: total,
    ignoredResponses: Math.max(totalResponses - total, 0),
    score,
    averageScore: Number((validValues.reduce((sum, value) => sum + value, 0) / total).toFixed(1)),
    distribution: [...counts.entries()].map(([value, count]) => ({
      value,
      count,
      percentage: total ? Number(((count / total) * 100).toFixed(1)) : 0,
    })),
    scoreLabel: 'NPS',
    scoreHint: 'Promotores (9-10) minus detratores (0-6). Notas 7-8 são neutras.',
    segments: [
      {
        label: 'Promotores',
        count: promoters,
        percentage: total ? Number(((promoters / total) * 100).toFixed(1)) : 0,
        tone: 'success',
      },
      {
        label: 'Neutros',
        count: passives,
        percentage: total ? Number(((passives / total) * 100).toFixed(1)) : 0,
        tone: 'warning',
      },
      {
        label: 'Detratores',
        count: detractors,
        percentage: total ? Number(((detractors / total) * 100).toFixed(1)) : 0,
        tone: 'danger',
      },
    ],
  };
};

const buildCsatMetric = (
  fieldKey: string,
  values: number[],
  totalResponses: number,
): SurveyMetricSummary | null => {
  const validValues = values.filter((value) => Number.isInteger(value) && value >= 0);
  if (validValues.length === 0) {
    return null;
  }

  const total = validValues.length;
  const minValue = Math.min(...validValues);
  const maxValue = Math.max(...validValues);
  const satisfiedThreshold = Math.max(maxValue - 1, minValue);
  const satisfiedCount = validValues.filter((value) => value >= satisfiedThreshold).length;
  const neutralCount = validValues.filter((value) => value < satisfiedThreshold && value > minValue).length;
  const dissatisfiedCount = total - satisfiedCount - neutralCount;
  const score = Number(((satisfiedCount / total) * 100).toFixed(1));

  const counts = new Map<string, number>();
  for (let index = minValue; index <= maxValue; index += 1) {
    counts.set(String(index), 0);
  }

  for (const value of validValues) {
    const key = String(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return {
    fieldKey,
    metricType: 'csat',
    label: 'Customer Satisfaction Score',
    totalResponses,
    validResponses: total,
    ignoredResponses: Math.max(totalResponses - total, 0),
    score,
    averageScore: Number((validValues.reduce((sum, value) => sum + value, 0) / total).toFixed(1)),
    distribution: [...counts.entries()].map(([value, count]) => ({
      value,
      count,
      percentage: total ? Number(((count / total) * 100).toFixed(1)) : 0,
    })),
    scoreLabel: 'CSAT',
    scoreHint: `Top-2-box automático da escala ${minValue}-${maxValue} (${Math.max(
      satisfiedThreshold,
      minValue,
    )}-${maxValue}).`,
    segments: [
      {
        label: 'Satisfeitos',
        count: satisfiedCount,
        percentage: total ? Number(((satisfiedCount / total) * 100).toFixed(1)) : 0,
        tone: 'success',
      },
      {
        label: 'Intermediários',
        count: neutralCount,
        percentage: total ? Number(((neutralCount / total) * 100).toFixed(1)) : 0,
        tone: 'warning',
      },
      {
        label: 'Baixa satisfação',
        count: dissatisfiedCount,
        percentage: total ? Number(((dissatisfiedCount / total) * 100).toFixed(1)) : 0,
        tone: 'danger',
      },
    ],
  };
};

const normalizeNumericSurveyValue = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().replace(',', '.');
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
};
