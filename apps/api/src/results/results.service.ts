import { Injectable } from '@nestjs/common';
import { buildCsv } from '../common/csv';
import { campaignFunnel } from '../common/campaign-metrics';
import { DatabaseService } from '../database/database.service';
import type {
  FlowCacheRecord,
  FlowCompletionPayloadField,
  FlowInputFieldDefinition,
  FlowResponseRecord,
  FlowScreenTransition,
} from '../database/types';

@Injectable()
export class ResultsService {
  constructor(private readonly database: DatabaseService) {}

  async listFlowResponses(
    filters?: {
      campaignId?: string;
      flowCacheId?: string;
      flowName?: string;
      contactId?: string;
      limit?: number;
    },
    scope: string | null = null,
  ) {
    return this.loadFlowResponses(filters, undefined, scope);
  }

  async exportFlowResponsesCsv(
    filters?: {
      campaignId?: string;
      flowCacheId?: string;
      flowName?: string;
      contactId?: string;
      limit?: number;
    },
    scope: string | null = null,
  ) {
    const rows = await this.loadFlowResponses(filters, undefined, scope);
    const flattenPayload = Boolean(filters?.flowCacheId || filters?.flowName);

    if (!flattenPayload) {
      const header = [
        'id',
        'completedAt',
        'campaignName',
        'flowName',
        'templateName',
        'contactName',
        'contactPhone',
        'responsePayload',
      ];

      const lines = rows.map((row) => [
        row.id,
        row.completedAt,
        row.campaignName ?? '',
        row.flowName ?? '',
        row.templateName ?? '',
        row.contactName ?? '',
        row.contactPhone ?? '',
        JSON.stringify(row.responsePayload ?? {}),
      ]);

      return buildCsv(header, lines);
    }

    const payloadColumns = [...new Set(rows.flatMap((row) => Object.keys(row.responsePayload ?? {})))].sort();
    const header = [
      'id',
      'completedAt',
      'campaignName',
      'flowName',
      'templateName',
      'contactName',
      'contactPhone',
      ...payloadColumns,
    ];

    const lines = rows.map((row) => {
      const payload = row.responsePayload ?? {};
      return [
        row.id,
        row.completedAt,
        row.campaignName ?? '',
        row.flowName ?? '',
        row.templateName ?? '',
        row.contactName ?? '',
        row.contactPhone ?? '',
        ...payloadColumns.map((column) => stringifyPayloadValue(payload[column])),
      ];
    });

    return buildCsv(header, lines);
  }

  private async loadFlowResponses(
    filters?: {
      campaignId?: string;
      flowCacheId?: string;
      flowName?: string;
      contactId?: string;
      limit?: number;
    },
    defaultLimit?: number,
    scope: string | null = null,
  ) {
    const state = await this.database.readMetaSnapshot();
    const rawResponses = await this.database.listFlowResponsesInDatabase(filters);
    const scopeCampaignsById = new Map(state.campaigns.map((c) => [c.id, c]));
    // Escopo de tenant: cliente só vê respostas de campanhas do próprio tenant.
    const filteredResponses =
      scope === null
        ? rawResponses
        : rawResponses.filter((r) => {
            const campaign = r.campaignId ? scopeCampaignsById.get(r.campaignId) : null;
            return campaign != null && (campaign.clientId ?? null) === scope;
          });
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

    const mappedResponses = filteredResponses
      .map((response) => {
        const campaign = response.campaignId
          ? campaignsById.get(response.campaignId) ?? null
          : null;
        const contact = response.contactId ? contactsById.get(response.contactId) ?? null : null;
        // `flows.id` é regerado a cada sync (DELETE+INSERT), então respostas antigas
        // guardam um flowCacheId órfão. Coalescer em vez de encadear ternário deixa
        // o metaFlowId (estável) resolver esses casos.
        const flow =
          (response.flowCacheId ? flowsById.get(response.flowCacheId) : undefined) ??
          (response.metaFlowId ? flowsByMetaFlowId.get(response.metaFlowId) : undefined) ??
          null;
        const template = response.templateCacheId
          ? templatesById.get(response.templateCacheId) ?? null
          : null;

        return {
          id: response.id,
          flowCacheId: response.flowCacheId ?? null,
          completedAt: response.completedAt,
          responsePayload: response.responsePayload,
          campaignName: campaign?.name ?? null,
          contactName: contact?.name ?? null,
          contactPhone: contact?.phoneE164 ?? null,
          flowName: flow?.name ?? response.metaFlowId ?? 'Flow não identificado',
          templateName: template?.name ?? null,
          detectedPayloadDefinitions: flow?.completionPayloadDefinitions ?? [],
        };
      })
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt));

    const flowNameFiltered = filters?.flowName
      ? mappedResponses.filter((response) => (response.flowName ?? 'Flow não identificado') === filters.flowName)
      : mappedResponses;

    const finalLimit = filters?.limit ?? defaultLimit;
    if (!finalLimit) {
      return flowNameFiltered;
    }

    return flowNameFiltered.slice(0, finalLimit);
  }

  async summary(scope: string | null = null) {
    const [state, allFlowResponses, allCampaignMessages, allMessageEvents] = await Promise.all([
      this.database.readMetaSnapshot(),
      this.database.listFlowResponsesInDatabase(),
      this.database.listCampaignMessagesInDatabase(),
      this.database.listMessageEventsInDatabase(),
    ]);
    // Escopo de tenant: restringe tudo às campanhas do tenant selecionado/forçado.
    const scopedCampaigns =
      scope === null
        ? state.campaigns
        : state.campaigns.filter((c) => (c.clientId ?? null) === scope);
    const scopedCampaignIds = new Set(scopedCampaigns.map((c) => c.id));
    const flowResponses =
      scope === null
        ? allFlowResponses
        : allFlowResponses.filter((r) => r.campaignId != null && scopedCampaignIds.has(r.campaignId));
    const campaignMessages =
      scope === null
        ? allCampaignMessages
        : allCampaignMessages.filter((m) => scopedCampaignIds.has(m.campaignId));
    const scopedMessageIds = new Set(campaignMessages.map((m) => m.id));
    const messageEvents =
      scope === null
        ? allMessageEvents
        : allMessageEvents.filter(
            (e) => e.campaignMessageId != null && scopedMessageIds.has(e.campaignMessageId),
          );
    const totalResponses = flowResponses.length;
    const byFlow = new Map<string, number>();
    const byCampaign = new Map<string, number>();
    const byDay = new Map<string, number>();
    const fieldCoverage = new Map<string, number>();
    const categoricalValues = new Map<string, Map<string, number>>();
    const surveyFieldValues = new Map<string, number[]>();
    // Escala declarada no FLOW_JSON por chave de payload. `null` marca conflito
    // entre flows diferentes que usam a mesma chave com escalas divergentes —
    // nesse caso caímos no fallback observado.
    const declaredFieldScales = new Map<string, DeclaredScale | null>();
    const declaredScalesByFlow = new Map<string, Map<string, DeclaredScale>>();
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

    for (const response of flowResponses) {
      const campaign = response.campaignId ? campaignsById.get(response.campaignId) ?? null : null;
      // Ver nota em loadFlowResponses: flowCacheId órfão precisa cair para metaFlowId,
      // senão a escala declarada do flow nunca é encontrada.
      const flow =
        (response.flowCacheId ? flowsById.get(response.flowCacheId) : undefined) ??
        (response.metaFlowId ? flowsByMetaFlowId.get(response.metaFlowId) : undefined) ??
        null;

      const flowKey = flow?.name ?? response.metaFlowId ?? 'Flow não identificado';
      byFlow.set(flowKey, (byFlow.get(flowKey) ?? 0) + 1);

      const campaignKey = campaign?.name ?? 'Sem campanha';
      byCampaign.set(campaignKey, (byCampaign.get(campaignKey) ?? 0) + 1);

      const dayKey = response.completedAt.slice(0, 10);
      byDay.set(dayKey, (byDay.get(dayKey) ?? 0) + 1);

      let flowScales: Map<string, DeclaredScale> | null = null;
      if (flow) {
        flowScales = declaredScalesByFlow.get(flow.id) ?? null;
        if (!flowScales) {
          flowScales = buildDeclaredFieldScales(flow);
          declaredScalesByFlow.set(flow.id, flowScales);
        }
      }

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

          // A métrica é agregada por chave de payload, atravessando flows. Só vale
          // escala declarada se TODA resposta que entra na agregação vier de um flow
          // que declara a mesma escala. Flow sem definição — ou não resolvido — não
          // pode herdar a escala do vizinho: isso descartaria respostas legítimas
          // como fora-de-faixa. `null` marca o fieldKey como observado.
          const declaredScale = flowScales?.get(fieldKey) ?? null;
          if (!declaredFieldScales.has(fieldKey)) {
            declaredFieldScales.set(fieldKey, declaredScale);
          } else {
            const current = declaredFieldScales.get(fieldKey) ?? null;
            if (current && (!declaredScale || current.signature !== declaredScale.signature)) {
              declaredFieldScales.set(fieldKey, null);
            }
          }
        }
      }
    }

    for (const message of campaignMessages) {
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

    for (const event of messageEvents) {
      if (event.eventType === 'send.accepted') {
        incrementTimeline(operationTimeline, event.occurredAt, 'accepted');
      }
    }

    const totalTrackedMessages = campaignMessages.length;
    const totalAcceptedMessages = campaignMessages.filter((message) => Boolean(message.providerMessageId)).length;
    const totalSentMessages = campaignMessages.filter((message) => Boolean(message.sentAt)).length;
    const totalDeliveredMessages = campaignMessages.filter((message) => Boolean(message.deliveredAt)).length;
    const totalReadMessages = campaignMessages.filter((message) => Boolean(message.readAt)).length;
    const totalFailedMessages = campaignMessages.filter((message) => message.status === 'failed').length;
    const totalPendingMessages = campaignMessages.filter((message) => message.status === 'pending').length;
    const totalProcessedMessages = totalTrackedMessages - totalPendingMessages;

    const statusDistribution = buildStatusDistribution(currentStatusCounts, totalTrackedMessages);
    const topDeliveryCampaigns = [...scopedCampaigns]
      .map((campaign) => {
        const funnel = campaignFunnel(campaign.summary);
        const { total, pending, deliveredTotal: delivered, readTotal: read, failed } = funnel;
        const processed = Math.max(total - pending, 0);
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
          successRate: funnel.deliveryRate,
          readRate: funnel.readRate,
          failureRate: total ? Number(((failed / total) * 100).toFixed(1)) : 0,
        };
      })
      .filter((campaign) => campaign.total > 0)
      .sort((left, right) => right.processed - left.processed)
      .slice(0, 8);

    const surveyMetrics = buildSurveyMetrics(surveyFieldValues, fieldCoverage, declaredFieldScales);

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

    const rows = await this.database.postgresQuery<Record<string, unknown>>(
      `SELECT id, name, phone_e164
       FROM contacts
       WHERE id = ANY($1::text[])`,
      [uniqueIds],
    );

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

const stringifyPayloadValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
};

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
  distribution: Array<{ value: string; count: number; percentage: number; label?: string }>;
  scoreLabel: string;
  scoreHint: string;
  /**
   * `declared`: a faixa da escala veio do FLOW_JSON (ou é normativa, caso do NPS).
   * `observed`: a faixa foi inferida das respostas recebidas — pode estar errada
   *   enquanto a coleta é pequena. Flows ainda não re-sincronizados caem aqui.
   */
  scaleSource: 'declared' | 'observed';
  /**
   * Orientação da escala, inferida dos rótulos declarados.
   * `ascending`: maior = melhor (evidência nos rótulos).
   * `descending`: menor = melhor (ex.: 0 "Muito satisfeito" ... 4 "Muito insatisfeito").
   * `assumed`: sem evidência nos rótulos — assume maior = melhor, como sempre foi.
   *   O front deve sinalizar ao operador, é uma suposição e não uma leitura.
   */
  scaleOrientation: ScaleOrientation;
  segments: Array<{ label: string; count: number; percentage: number; tone: 'success' | 'warning' | 'danger' }>;
};

type ScaleOrientation = 'ascending' | 'descending' | 'assumed';

/** Escala declarada no `data-source` do componente de entrada do flow. */
type DeclaredScale = {
  min: number;
  max: number;
  /** Valores declarados, únicos e ascendentes. Suporta escala não contígua (1,3,5). */
  values: number[];
  labels: Map<number, string>;
  orientation: ScaleOrientation;
  signature: string;
};

// Tetos defensivos. Nenhuma escala de pesquisa real chega perto disso, e tanto o
// Map de contagem quanto a `distribution` são materializados em memória e
// renderizados item a item no front — faixa densa sem teto é DoS de event loop
// e de heap para todos os tenants (o processo é single-threaded).
const MAX_DECLARED_SCALE_OPTIONS = 50;
const MAX_DECLARED_SCALE_SPREAD = 100;
const MAX_DISTRIBUTION_BUCKETS = 100;

// Profundidade máxima da cadeia de telas percorrida. Flow de pesquisa tem poucas
// telas; aqui é só guarda de pilha — quem garante terminação é o memo/ciclo.
const MAX_TRANSITION_DEPTH = 64;

/**
 * Liga cada chave do payload de `complete` ao componente de entrada que originou
 * o valor, e devolve a escala declarada quando ela é numérica.
 *
 * Em flow multi-tela só a última tela usa `${form.x}`: as respostas anteriores
 * chegam ao `complete` como `${data.x}`, encadeadas pelos payloads das ações
 * `navigate`. Por isso a resolução caminha o grafo de telas para trás, de
 * `${data.x}` até o `${form.x}` que de fato produziu o valor.
 */
const buildDeclaredFieldScales = (flow: FlowCacheRecord): Map<string, DeclaredScale> => {
  const scales = new Map<string, DeclaredScale>();
  const inputs = flow.inputFieldDefinitions ?? [];
  if (inputs.length === 0) {
    return scales;
  }

  // Índice montado UMA vez por flow: a busca linear dentro do laço de campos era
  // O(campos x componentes), sem teto em nenhum dos dois lados. Agora é O(campos +
  // componentes), e `toDeclaredScale` roda uma vez por componente.
  const inputScales = buildInputScaleIndex(inputs);
  // Compartilhado por todos os campos do flow: nós repetidos entre campos também
  // aproveitam o memo.
  const memo: ScaleMemo = new Map();

  // Arestas indexadas pela tela de DESTINO: para saber de onde veio `${data.x}`
  // em N, olha-se quem navegou para N.
  const transitionsByTarget = new Map<string, FlowScreenTransition[]>();
  for (const transition of flow.screenTransitions ?? []) {
    const inbound = transitionsByTarget.get(transition.nextScreenId) ?? [];
    inbound.push(transition);
    transitionsByTarget.set(transition.nextScreenId, inbound);
  }

  for (const definition of flow.completionPayloadDefinitions ?? []) {
    for (const field of definition.payloadFields ?? []) {
      const scale = resolveFieldScale(
        field,
        definition.screenId,
        inputScales,
        transitionsByTarget,
        memo,
        0,
      );
      if (scale) {
        scales.set(field.key, scale);
      }
    }
  }

  return scales;
};

/** Chave de `${data.X}`; null para qualquer outra expressão. */
const dataReferenceKey = (field: FlowCompletionPayloadField): string | null => {
  if (field.sourceType !== 'expression' || !field.sourceField) {
    return null;
  }

  return field.expression && /^\$\{data\.[^}]+\}$/.test(field.expression)
    ? field.sourceField
    : null;
};

/**
 * Escalas dos componentes indexadas por `${screenId}::${name}` e por `name`.
 * Colisão de nome vira `null` (ambíguo): nunca se escolhe um componente
 * arbitrariamente — na dúvida a métrica cai para escala observada.
 */
type InputScaleIndex = {
  byScreen: Map<string, DeclaredScale | null>;
  byName: Map<string, DeclaredScale | null>;
};

const buildInputScaleIndex = (inputs: FlowInputFieldDefinition[]): InputScaleIndex => {
  const byScreen = new Map<string, DeclaredScale | null>();
  const byName = new Map<string, DeclaredScale | null>();

  for (const input of inputs) {
    const scale = toDeclaredScale(input);
    const screenKey = `${input.screenId}::${input.name}`;
    byScreen.set(screenKey, byScreen.has(screenKey) ? null : scale);
    byName.set(input.name, byName.has(input.name) ? null : scale);
  }

  return { byScreen, byName };
};

const resolveInputScale = (
  fieldName: string,
  screenId: string,
  inputScales: InputScaleIndex,
): DeclaredScale | null => {
  const screenKey = `${screenId}::${fieldName}`;
  if (inputScales.byScreen.has(screenKey)) {
    return inputScales.byScreen.get(screenKey) ?? null;
  }

  // Sem correspondência na própria tela, só aceita se o nome for inequívoco no
  // flow inteiro.
  return inputScales.byName.get(fieldName) ?? null;
};

/**
 * Marcador de nó em resolução. Serve de detector de ciclo: reencontrar um nó
 * ainda `PENDING` significa que a aresta volta para dentro do próprio cálculo.
 */
const RESOLVING = Symbol('resolving');
type ScaleMemo = Map<string, DeclaredScale | null | typeof RESOLVING>;

const resolveFieldScale = (
  field: FlowCompletionPayloadField,
  screenId: string,
  inputScales: InputScaleIndex,
  transitionsByTarget: Map<string, FlowScreenTransition[]>,
  memo: ScaleMemo,
  depth: number,
): DeclaredScale | null => {
  // Guarda de pilha, não de trabalho: com o memo cada nó é calculado uma vez, mas
  // uma cadeia longuíssima ainda recursaria fundo. Fica muito acima de qualquer
  // flow real.
  //
  // Repare que esta guarda retorna ANTES de calcular o `memoKey`, de propósito:
  // o resultado da truncagem NÃO é memoizado. A profundidade não faz parte da
  // chave, então gravar `null` aqui vincularia à chave um resultado que depende
  // do caminho por onde o nó foi alcançado. Um nó atingido a 70 de profundidade
  // por um caminho e a 3 por outro seria condenado ao `null` do primeiro. Do
  // jeito que está, ele é recalculado e resolve pelo caminho curto. Não "conserte"
  // isto memoizando o resultado da truncagem — seria regressão.
  if (depth > MAX_TRANSITION_DEPTH) {
    return null;
  }

  if (field.sourceType === 'form' && field.sourceField) {
    return resolveInputScale(field.sourceField, screenId, inputScales);
  }

  const dataKey = dataReferenceKey(field);
  if (!dataKey) {
    return null;
  }

  // Memo por NÓ `(tela, chave)`, não por caminho. Sem isto o número de chamadas é
  // o número de caminhos raiz→folha (k^profundidade, k = arestas paralelas de
  // entrada por tela), e o teto de arestas não limita caminhos: 41 arestas
  // paralelas em 12 níveis são ~2,2e19 chamadas. Com memo é O(nós + arestas).
  const memoKey = `${screenId}::${dataKey}`;
  const cached = memo.get(memoKey);
  if (cached !== undefined) {
    return cached === RESOLVING ? null : cached;
  }
  memo.set(memoKey, RESOLVING);

  let resolved: DeclaredScale | null = null;
  for (const transition of transitionsByTarget.get(screenId) ?? []) {
    // `parseJsonArray` valida o container, não o formato dos elementos: uma aresta
    // com `payloadFields` não-array (JSONB adulterado) lançaria aqui dentro da
    // janela do memo, deixando o nó preso em RESOLVING até o fim da chamada.
    if (!Array.isArray(transition.payloadFields)) {
      continue;
    }

    const upstream = transition.payloadFields.find((candidate) => candidate.key === dataKey);
    if (!upstream) {
      continue;
    }

    const candidate = resolveFieldScale(
      upstream,
      transition.screenId,
      inputScales,
      transitionsByTarget,
      memo,
      depth + 1,
    );
    // Caminho de entrada que não resolve, ou que resolve para escala diferente,
    // torna a origem ambígua. Na dúvida, observado.
    if (!candidate || (resolved && resolved.signature !== candidate.signature)) {
      resolved = null;
      break;
    }
    resolved = candidate;
  }

  memo.set(memoKey, resolved);
  return resolved;
};

// Termos comparados POR PALAVRA, nunca por substring: `muito insatisfeito` contém
// `satisfeito`, e um `includes` classificaria o pior rótulo da escala como positivo.
// Tokenizar resolve o prefixo, porque `insatisfeito` é um token distinto de
// `satisfeito`. A negação explícita ("não satisfeito") inverte o sinal do termo.
const NEGATIVE_SCALE_TERMS = new Set([
  'insatisfeito',
  'insatisfeita',
  'insatisfatorio',
  'insatisfatoria',
  'ruim',
  'pessimo',
  'pessima',
  'dificil',
  'discordo',
  'improvavel',
]);

const POSITIVE_SCALE_TERMS = new Set([
  'satisfeito',
  'satisfeita',
  'satisfatorio',
  'satisfatoria',
  'bom',
  'boa',
  'otimo',
  'otima',
  'excelente',
  'facil',
  'concordo',
  'provavel',
]);

const NEGATION_TERMS = new Set(['nao', 'nunca', 'jamais', 'nenhum', 'nenhuma']);

const normalizeLabelTokens = (label: string): string[] =>
  label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

const classifyLabelSentiment = (label: string | undefined): 'positive' | 'negative' | null => {
  if (!label) {
    return null;
  }

  let negated = false;
  for (const token of normalizeLabelTokens(label)) {
    if (NEGATION_TERMS.has(token)) {
      negated = true;
      continue;
    }
    if (NEGATIVE_SCALE_TERMS.has(token)) {
      return negated ? 'positive' : 'negative';
    }
    if (POSITIVE_SCALE_TERMS.has(token)) {
      return negated ? 'negative' : 'positive';
    }
  }

  return null;
};

/**
 * Orientação pelos extremos declarados. Só afirma quando os dois extremos têm
 * sinal e são opostos; qualquer outra combinação (sem rótulo, rótulo neutro,
 * mesmo sinal nos dois lados) é `assumed` — não se inventa orientação.
 */
const detectScaleOrientation = (
  values: number[],
  labels: Map<number, string>,
): ScaleOrientation => {
  const lowest = classifyLabelSentiment(labels.get(values[0]));
  const highest = classifyLabelSentiment(labels.get(values[values.length - 1]));

  if (lowest === 'negative' && highest === 'positive') {
    return 'ascending';
  }
  if (lowest === 'positive' && highest === 'negative') {
    return 'descending';
  }

  return 'assumed';
};

const toDeclaredScale = (input: FlowInputFieldDefinition): DeclaredScale | null => {
  const options = input.options ?? [];
  if (options.length < 2 || options.length > MAX_DECLARED_SCALE_OPTIONS) {
    return null;
  }

  const labels = new Map<number, string>();
  const unique = new Set<number>();
  for (const option of options) {
    const parsed = Number(option.id);
    if (!Number.isInteger(parsed)) {
      // Escala não numérica (ex.: ids textuais): não serve de faixa.
      return null;
    }

    unique.add(parsed);
    if (option.title) {
      labels.set(parsed, option.title);
    }
  }

  const values = [...unique].sort((left, right) => left - right);
  if (values.length < 2) {
    return null;
  }

  const min = values[0];
  const max = values[values.length - 1];
  // Ids do tipo ano/data/código (ex.: "1" e "20250101") passam no teste de inteiro
  // mas não são escala de pesquisa. Rejeitar aqui cai no fallback observado.
  if (max - min > MAX_DECLARED_SCALE_SPREAD) {
    return null;
  }

  const orientation = detectScaleOrientation(values, labels);
  return {
    min,
    max,
    values,
    labels,
    orientation,
    // A orientação entra na assinatura: dois flows com a mesma faixa mas leitura
    // oposta são conflito, não equivalência.
    signature: `${min}..${max}|${values.join(',')}|${orientation}`,
  };
};

const minMaxOf = (values: number[]): [number, number] => {
  // reduce/laço em vez de Math.min(...values): o spread estoura a pilha com
  // volume alto de respostas.
  let min = values[0];
  let max = values[0];
  for (const value of values) {
    if (value < min) {
      min = value;
    }
    if (value > max) {
      max = value;
    }
  }
  return [min, max];
};

/**
 * Buckets da distribuição.
 * - Com escala declarada: sai das próprias opções declaradas — nunca materializa
 *   a faixa densa e cobre escalas não contíguas.
 * - Sem escala: mantém a faixa densa observada (comportamento atual) apenas
 *   enquanto ela couber no teto. O caminho observado recebe valor livre do
 *   respondente (um TextInput numérico chamado `csat_*` nunca tem `data-source`),
 *   então `999999999` não pode virar 1e9 buckets.
 */
const buildDistributionCounts = (
  validValues: number[],
  scale: DeclaredScale | null,
  minValue: number,
  maxValue: number,
): Map<string, number> => {
  const counts = new Map<string, number>();

  if (scale) {
    for (const value of scale.values) {
      counts.set(String(value), 0);
    }
  } else if (maxValue - minValue + 1 <= MAX_DISTRIBUTION_BUCKETS) {
    for (let index = minValue; index <= maxValue; index += 1) {
      counts.set(String(index), 0);
    }
  }

  // Contar os valores distintos é O(n) e limitado pelo número de respostas —
  // o que era ilimitado é a faixa densa acima, não isto.
  for (const value of validValues) {
    const key = String(value);
    if (scale && !counts.has(key)) {
      continue;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  if (counts.size <= MAX_DISTRIBUTION_BUCKETS) {
    return counts;
  }

  // Escala observada dispersa demais: mantém os buckets mais frequentes.
  return new Map(
    [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_DISTRIBUTION_BUCKETS)
      .sort((left, right) => Number(left[0]) - Number(right[0])),
  );
};

const buildDistribution = (
  counts: Map<string, number>,
  total: number,
  scale: DeclaredScale | null,
): SurveyMetricSummary['distribution'] =>
  [...counts.entries()]
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .map(([value, count]) => {
      const label = scale?.labels.get(Number(value));
      return {
        value,
        count,
        percentage: total ? Number(((count / total) * 100).toFixed(1)) : 0,
        ...(label ? { label } : {}),
      };
    });

const buildSurveyMetrics = (
  fieldValues: Map<string, number[]>,
  fieldCoverage: Map<string, number>,
  declaredScales: Map<string, DeclaredScale | null> = new Map(),
): SurveyMetricSummary[] => {
  const metrics: SurveyMetricSummary[] = [];

  for (const [fieldKey, values] of fieldValues.entries()) {
    const normalizedKey = fieldKey.trim().toLowerCase();
    const declaredScale = declaredScales.get(fieldKey) ?? null;

    if (normalizedKey.includes('nps')) {
      const metric = buildNpsMetric(
        fieldKey,
        values,
        fieldCoverage.get(fieldKey) ?? values.length,
        declaredScale,
      );
      if (metric) {
        metrics.push(metric);
      }
      continue;
    }

    if (normalizedKey.includes('csat') || normalizedKey.includes('cesat')) {
      const metric = buildCsatMetric(
        fieldKey,
        values,
        fieldCoverage.get(fieldKey) ?? values.length,
        declaredScale,
      );
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
  declaredScale: DeclaredScale | null = null,
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
    distribution: buildDistribution(counts, total, declaredScale),
    scoreLabel: 'NPS',
    scoreHint: 'Promotores (9-10) minus detratores (0-6). Notas 7-8 são neutras.',
    // A faixa 0-10 e os cortes do NPS são normativos da métrica, nunca inferidos
    // das respostas; a definição do flow só acrescenta rótulos.
    scaleSource: 'declared',
    // No NPS maior = melhor por definição da métrica, não por leitura de rótulo.
    scaleOrientation: 'ascending',
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

const buildCsatScoreHint = (
  declared: boolean,
  orientation: ScaleOrientation,
  minValue: number,
  maxValue: number,
  satisfiedThreshold: number,
): string => {
  if (!declared) {
    // Texto preservado: é o comportamento antigo, para flow sem definição.
    return `Top-2-box automático da escala ${minValue}-${maxValue} (${Math.max(
      satisfiedThreshold,
      minValue,
    )}-${maxValue}).`;
  }

  if (orientation === 'descending') {
    return `Escala declarada ${minValue}-${maxValue} invertida pelos rótulos (menor = melhor): top-2-box ${minValue}-${Math.min(
      satisfiedThreshold,
      maxValue,
    )}.`;
  }

  const base = `Top-2-box da escala declarada no flow ${minValue}-${maxValue} (${Math.max(
    satisfiedThreshold,
    minValue,
  )}-${maxValue}).`;

  return orientation === 'assumed'
    ? `${base} Orientação não identificada pelos rótulos: assumido maior = melhor.`
    : base;
};

const buildCsatMetric = (
  fieldKey: string,
  values: number[],
  totalResponses: number,
  declaredScale: DeclaredScale | null = null,
): SurveyMetricSummary | null => {
  // Com escala declarada, só valem os valores declarados (checagem por conjunto,
  // não por faixa — a escala pode ser não contígua). Sem ela, o filtro antigo.
  const declaredValues = declaredScale ? new Set(declaredScale.values) : null;
  const validValues = declaredValues
    ? values.filter((value) => Number.isInteger(value) && declaredValues.has(value))
    : values.filter((value) => Number.isInteger(value) && value >= 0);
  if (validValues.length === 0) {
    return null;
  }

  const total = validValues.length;
  const [observedMin, observedMax] = minMaxOf(validValues);
  const minValue = declaredScale ? declaredScale.min : observedMin;
  const maxValue = declaredScale ? declaredScale.max : observedMax;
  const orientation: ScaleOrientation = declaredScale ? declaredScale.orientation : 'assumed';
  // Escala invertida (0 "Muito satisfeito" ... 4 "Muito insatisfeito"): o top-2-box
  // são as duas opções mais BAIXAS. Sem essa leitura, o score mediria justamente
  // os insatisfeitos e os apresentaria como satisfação.
  const inverted = orientation === 'descending';
  // Top-2-box = as duas opções extremas do lado "bom" da escala. Em escala
  // contígua ascendente isso é `max - 1` (1-5 → corte 4); em escala não contígua
  // (1,3,5 → corte 3) passa a ser realmente top-2-box em vez de top-1.
  const satisfiedThreshold = declaredScale
    ? inverted
      ? declaredScale.values[1] ?? maxValue
      : declaredScale.values[declaredScale.values.length - 2] ?? minValue
    : Math.max(maxValue - 1, minValue);
  const satisfiedCount = inverted
    ? validValues.filter((value) => value <= satisfiedThreshold).length
    : validValues.filter((value) => value >= satisfiedThreshold).length;
  const neutralCount = inverted
    ? validValues.filter((value) => value > satisfiedThreshold && value < maxValue).length
    : validValues.filter((value) => value < satisfiedThreshold && value > minValue).length;
  const dissatisfiedCount = total - satisfiedCount - neutralCount;
  const score = Number(((satisfiedCount / total) * 100).toFixed(1));

  const counts = buildDistributionCounts(validValues, declaredScale, minValue, maxValue);

  return {
    fieldKey,
    metricType: 'csat',
    label: 'Customer Satisfaction Score',
    totalResponses,
    validResponses: total,
    ignoredResponses: Math.max(totalResponses - total, 0),
    score,
    averageScore: Number((validValues.reduce((sum, value) => sum + value, 0) / total).toFixed(1)),
    distribution: buildDistribution(counts, total, declaredScale),
    scoreLabel: 'CSAT',
    scoreHint: buildCsatScoreHint(
      Boolean(declaredScale),
      orientation,
      minValue,
      maxValue,
      satisfiedThreshold,
    ),
    scaleSource: declaredScale ? 'declared' : 'observed',
    scaleOrientation: orientation,
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
