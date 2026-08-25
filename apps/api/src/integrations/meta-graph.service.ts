import { Injectable } from '@nestjs/common';
import { CryptoService } from '../common/crypto.service';
import { extractVariableDescriptors, newId, nowIso } from '../database/helpers';
import {
  FlowCacheRecord,
  FlowCompletionPayloadDefinition,
  FlowFieldOptionDefinition,
  FlowInputFieldDefinition,
  FlowScreenTransition,
  IntegrationRecord,
  TemplateCacheRecord,
} from '../database/types';

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly payload?: Record<string, unknown>,
  ) {
    super(message);
  }
}

@Injectable()
export class MetaGraphService {
  private readonly requestTimeoutMs = 15_000;

  constructor(private readonly crypto: CryptoService) {}

  async testConnection(integration: IntegrationRecord): Promise<Record<string, unknown>> {
    return this.request(
      integration,
      'GET',
      `/${integration.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,throughput`,
    );
  }

  async syncTemplates(integration: IntegrationRecord): Promise<TemplateCacheRecord[]> {
    const templates = await this.paginate(
      integration,
      `/${integration.wabaId}/message_templates?limit=100`,
    );
    const syncedAt = nowIso();

    return templates.map((item) => {
      const raw = item as Record<string, unknown>;
      const components = Array.isArray(raw.components) ? raw.components : [];
      const flowButtonRef = components
        .flatMap((component) => {
          const record = component as Record<string, unknown>;
          const buttons = Array.isArray(record.buttons)
            ? (record.buttons as Record<string, unknown>[])
            : [];
          return buttons.map((button, buttonIndex) => ({
            button,
            buttonIndex,
          }));
        })
        .find((entry) => entry.button.type === 'FLOW');
      const flowButton = flowButtonRef
        ? {
            ...flowButtonRef.button,
            buttonIndex: flowButtonRef.buttonIndex,
          }
        : null;

      return {
        id: newId(),
        integrationId: integration.id,
        metaTemplateId: String(raw.id ?? raw.name ?? newId()),
        name: String(raw.name ?? ''),
        languageCode: String((raw.language as string) ?? raw.language ?? 'pt_BR'),
        category: String(raw.category ?? 'UNKNOWN'),
        status: String(raw.status ?? 'UNKNOWN'),
        components,
        hasFlowButton: Boolean(flowButton),
        flowButtonMeta: flowButton ?? null,
        variableDescriptors: extractVariableDescriptors(components),
        raw,
        lastSyncedAt: syncedAt,
      };
    });
  }

  async syncFlows(integration: IntegrationRecord): Promise<FlowCacheRecord[]> {
    const flows = await this.paginate(integration, `/${integration.wabaId}/flows?limit=100`);
    const syncedAt = nowIso();
    const detailed: FlowCacheRecord[] = [];

    for (const item of flows) {
      const base = item as Record<string, unknown>;
      const flowId = String(base.id);
      const details = await this.request<Record<string, unknown>>(
        integration,
        'GET',
        `/${flowId}?fields=id,name,categories,preview,status,validation_errors,json_version,data_api_version,data_channel_uri,health_status`,
      );
      let assets: Record<string, unknown>[] = [];
      try {
        const assetsPayload = await this.request<{ data?: Record<string, unknown>[] }>(
          integration,
          'GET',
          `/${flowId}/assets`,
        );
        assets = assetsPayload.data ?? [];
      } catch {
        assets = [];
      }
      const { completionPayloadDefinitions, inputFieldDefinitions, screenTransitions } =
        await this.readFlowJsonDefinitions(assets);

      detailed.push({
        id: newId(),
        integrationId: integration.id,
        metaFlowId: flowId,
        name: String(details.name ?? base.name ?? ''),
        categories: Array.isArray(details.categories)
          ? details.categories.map((value) => String(value))
          : [],
        status: String(details.status ?? base.status ?? 'UNKNOWN'),
        jsonVersion: String(details.json_version ?? ''),
        dataApiVersion: String(details.data_api_version ?? ''),
        previewUrl:
          typeof (details.preview as Record<string, unknown>)?.preview_url === 'string'
            ? String((details.preview as Record<string, unknown>).preview_url)
            : null,
        previewExpiresAt:
          typeof (details.preview as Record<string, unknown>)?.expires_at === 'string'
            ? String((details.preview as Record<string, unknown>).expires_at)
            : null,
        healthStatus:
          typeof details.health_status === 'object'
            ? (details.health_status as Record<string, unknown>)
            : null,
        endpointUri:
          typeof details.data_channel_uri === 'string'
            ? details.data_channel_uri
            : null,
        assets,
        completionPayloadDefinitions,
        inputFieldDefinitions,
        screenTransitions,
        raw: details,
        lastSyncedAt: syncedAt,
      });
    }

    return detailed;
  }

  async sendMessage(
    integration: IntegrationRecord,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.request(
      integration,
      'POST',
      `/${integration.phoneNumberId}/messages`,
      payload,
    );
  }

  private async paginate(
    integration: IntegrationRecord,
    path: string,
  ): Promise<Record<string, unknown>[]> {
    const collected: Record<string, unknown>[] = [];
    let nextPath: string | undefined = path;

    while (nextPath) {
      const response: {
        data?: Record<string, unknown>[];
        paging?: { next?: string };
      } = await this.request<{ data?: Record<string, unknown>[]; paging?: { next?: string } }>(
        integration,
        'GET',
        nextPath,
        undefined,
        nextPath.startsWith('http'),
      );
      collected.push(...(response.data ?? []));
      nextPath = response.paging?.next;
    }

    return collected;
  }

  private async request<T extends Record<string, unknown>>(
    integration: IntegrationRecord,
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    absolute = false,
  ): Promise<T> {
    const token = this.crypto.decrypt(integration.accessTokenCiphertext);
    const baseUrl = absolute
      ? path
      : `${integration.graphApiBase}/${integration.graphApiVersion}${path}`;
    let response: Response;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      response = await fetch(baseUrl, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'AbortError'
          ? `Timeout ao chamar a Meta API (${this.requestTimeoutMs} ms)`
          : error instanceof Error
            ? error.message
            : 'Falha de rede ao chamar a Meta API';
      throw new MetaApiError(reason);
    } finally {
      clearTimeout(timeout);
    }

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const error = payload.error as Record<string, unknown> | undefined;
      throw new MetaApiError(
        String(error?.message ?? 'Meta API request failed'),
        Number(error?.code ?? 0),
        payload,
      );
    }

    return payload as T;
  }

  /**
   * Baixa o FLOW_JSON uma única vez e extrai as duas definições que usamos:
   * o payload do `complete` e os componentes de entrada (com a escala declarada
   * no `data-source`). Falha de download mantém o comportamento antigo (vazio).
   */
  private async readFlowJsonDefinitions(assets: Record<string, unknown>[]): Promise<{
    completionPayloadDefinitions: FlowCompletionPayloadDefinition[];
    inputFieldDefinitions: FlowInputFieldDefinition[];
    screenTransitions: FlowScreenTransition[];
  }> {
    const empty = {
      completionPayloadDefinitions: [],
      inputFieldDefinitions: [],
      screenTransitions: [],
    };
    const assetUrl = assets.find(
      (asset) =>
        asset.asset_type === 'FLOW_JSON' && typeof asset.download_url === 'string',
    )?.download_url;
    if (typeof assetUrl !== 'string' || !assetUrl) {
      return empty;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await fetch(assetUrl, { signal: controller.signal });
      if (!response.ok) {
        return empty;
      }

      // O timeout limita duração, não volume. Rejeita pelo Content-Length quando
      // ele existe e, de qualquer forma, corta a leitura no teto de bytes.
      const declaredLength = Number(response.headers.get('content-length') ?? Number.NaN);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_FLOW_JSON_BYTES) {
        return empty;
      }

      const body = await readBodyWithLimit(response, MAX_FLOW_JSON_BYTES);
      if (body === null) {
        return empty;
      }

      const flowJson = JSON.parse(body) as Record<string, unknown>;
      return {
        completionPayloadDefinitions: extractCompletionPayloadDefinitions(flowJson),
        inputFieldDefinitions: extractInputFieldDefinitions(flowJson),
        screenTransitions: extractScreenTransitions(flowJson),
      };
    } catch {
      return empty;
    } finally {
      // Mantém o timeout armado durante a leitura do corpo, não só do handshake.
      clearTimeout(timeout);
    }
  }
}

const MAX_FLOW_JSON_BYTES = 5 * 1024 * 1024;

/** Lê o corpo em streaming e aborta se passar do teto, sem bufferizar o excesso. */
const readBodyWithLimit = async (response: Response, maxBytes: number): Promise<string | null> => {
  if (!response.body) {
    return null;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }

      text += decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // reader já liberado pelo cancel(): nada a fazer.
    }
  }

  return text + decoder.decode();
};

const extractCompletionPayloadDefinitions = (
  flowJson: Record<string, unknown>,
): FlowCompletionPayloadDefinition[] => {
  const screens = Array.isArray(flowJson.screens) ? flowJson.screens : [];
  const definitions: FlowCompletionPayloadDefinition[] = [];

  for (const screen of screens as Array<Record<string, unknown>>) {
    const screenId = String(screen.id ?? '');
    // `findForms` devolve também os Forms aninhados e o walker varre a subárvore
    // inteira de cada um, então a MESMA ação é encontrada uma vez por nível de
    // aninhamento. Dedup por identidade do nó (exato) e por assinatura do payload.
    const seenActions = new Set<unknown>();
    const seenSignatures = new Set<string>();
    const forms = findForms(screen.layout);
    for (const form of forms) {
      const actions = findCompleteActions(form);
      for (const action of actions) {
        if (seenActions.has(action)) {
          continue;
        }
        seenActions.add(action);

        const payload = asRecord(action.payload);
        if (!payload) {
          continue;
        }
        const payloadFields = Object.entries(payload).map(([key, value]) =>
          normalizePayloadField(key, value),
        );
        if (payloadFields.length === 0) {
          continue;
        }

        const actionName = String(action.name ?? 'complete');
        const signature = `${screenId}::${actionName}::${JSON.stringify(payloadFields)}`;
        if (seenSignatures.has(signature)) {
          continue;
        }
        seenSignatures.add(signature);

        definitions.push({
          screenId,
          formName: typeof form.name === 'string' ? form.name : null,
          actionName,
          payloadFields,
        });
      }
    }
  }

  return definitions;
};

// Teto defensivo: um flow de pesquisa tem poucas telas. Limita o grafo percorrido
// na resolução da cadeia de `${data.x}`.
const MAX_SCREEN_TRANSITIONS = 500;
const MAX_INPUT_FIELD_DEFINITIONS = 500;

/**
 * Extrai as arestas de navegação entre telas (ações `navigate` com destino
 * estático). São elas que permitem rastrear de onde veio cada `${data.x}` que
 * chega ao `complete`. Mesmo walker/wrapper Form das demais extrações.
 */
const extractScreenTransitions = (flowJson: Record<string, unknown>): FlowScreenTransition[] => {
  const screens = Array.isArray(flowJson.screens) ? flowJson.screens : [];
  const transitions: FlowScreenTransition[] = [];

  for (const screen of screens as Array<Record<string, unknown>>) {
    const screenId = String(screen.id ?? '');
    // Ver nota em extractCompletionPayloadDefinitions: Form aninhado faz a mesma
    // ação aparecer N vezes. Aresta duplicada vira caminho paralelo no grafo de
    // telas, então a dedup vem ANTES do teto — o teto limita tamanho, não caminhos.
    const seenActions = new Set<unknown>();
    const seenEdges = new Set<string>();
    for (const form of findForms(screen.layout)) {
      for (const action of findActionsByName(form, 'navigate')) {
        if (seenActions.has(action)) {
          continue;
        }
        seenActions.add(action);

        const next = asRecord(action.next);
        const nextScreenId =
          next && String(next.type ?? 'screen') === 'screen' && typeof next.name === 'string'
            ? next.name
            : '';
        const payload = asRecord(action.payload);
        if (!nextScreenId || !payload) {
          continue;
        }

        const payloadFields = Object.entries(payload).map(([key, value]) =>
          normalizePayloadField(key, value),
        );
        if (payloadFields.length === 0) {
          continue;
        }

        const edgeSignature = `${screenId}->${nextScreenId}::${JSON.stringify(payloadFields)}`;
        if (seenEdges.has(edgeSignature)) {
          continue;
        }
        seenEdges.add(edgeSignature);

        transitions.push({ screenId, nextScreenId, payloadFields });
        if (transitions.length >= MAX_SCREEN_TRANSITIONS) {
          return transitions;
        }
      }
    }
  }

  return transitions;
};

const INPUT_COMPONENT_TYPES = new Set([
  'RadioButtonsGroup',
  'Dropdown',
  'CheckboxGroup',
  'ChipsSelector',
  'TextArea',
  'TextInput',
]);

/**
 * Extrai os componentes de entrada declarados em cada tela do FLOW_JSON.
 * Mesmo walker do payload de `complete` (exige o wrapper "type": "Form").
 * Para componentes de escolha, guarda as opções estáticas do `data-source`
 * (`id` + `title`) — é a escala declarada da pergunta.
 */
const extractInputFieldDefinitions = (
  flowJson: Record<string, unknown>,
): FlowInputFieldDefinition[] => {
  const screens = Array.isArray(flowJson.screens) ? flowJson.screens : [];
  const definitions: FlowInputFieldDefinition[] = [];

  for (const screen of screens as Array<Record<string, unknown>>) {
    const screenId = String(screen.id ?? '');
    // Dedup por IDENTIDADE do componente: com Form aninhado o mesmo nó é visitado
    // uma vez por Form que o contém. A chave antiga incluía o formName, que muda
    // entre os níveis, então não pegava esse caso — e o componente repetido virava
    // colisão de nome no índice de escalas, derrubando a escala para "observada".
    // Componentes DISTINTOS com o mesmo nome na mesma tela continuam ambos aqui,
    // e a ambiguidade é resolvida (conservadoramente) no índice.
    const seenNodes = new Set<unknown>();
    const forms = findForms(screen.layout);
    for (const form of forms) {
      const formName = typeof form.name === 'string' ? form.name : null;
      walkNode(form, (current) => {
        const type = typeof current.type === 'string' ? current.type : '';
        if (!INPUT_COMPONENT_TYPES.has(type)) {
          return;
        }

        const name = typeof current.name === 'string' ? current.name : '';
        if (!name) {
          return;
        }

        if (seenNodes.has(current)) {
          return;
        }
        seenNodes.add(current);

        if (definitions.length >= MAX_INPUT_FIELD_DEFINITIONS) {
          return;
        }

        definitions.push({
          screenId,
          formName,
          name,
          type,
          options: normalizeDataSourceOptions(current['data-source']),
        });
      });
    }
  }

  return definitions;
};

// Um Dropdown legítimo (cidades, procedimentos) tem milhares de entradas. Isso não
// é escala de pesquisa e não pode inchar `input_field_definitions_json`, que volta
// inteiro em todo readMetaSnapshot() — lido por /results/summary,
// /results/flow-responses e /library/flows. Acima do teto, descarta e cai no fallback.
const MAX_DATA_SOURCE_OPTIONS = 200;
const MAX_OPTION_TEXT_LENGTH = 200;

const normalizeDataSourceOptions = (value: unknown): FlowFieldOptionDefinition[] | null => {
  if (!Array.isArray(value) || value.length > MAX_DATA_SOURCE_OPTIONS) {
    return null;
  }

  const options: FlowFieldOptionDefinition[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }

    const id =
      typeof record.id === 'string' || typeof record.id === 'number' ? String(record.id) : '';
    if (!id) {
      continue;
    }

    options.push({
      id: id.slice(0, MAX_OPTION_TEXT_LENGTH),
      title:
        typeof record.title === 'string' ? record.title.slice(0, MAX_OPTION_TEXT_LENGTH) : null,
    });
  }

  return options.length > 0 ? options : null;
};

const findForms = (node: unknown): Array<Record<string, unknown>> => {
  const forms: Array<Record<string, unknown>> = [];
  walkNode(node, (current) => {
    if (current.type === 'Form') {
      forms.push(current);
    }
  });
  return forms;
};

const findActionsByName = (
  form: Record<string, unknown>,
  actionName: string,
): Array<Record<string, unknown>> => {
  const actions: Array<Record<string, unknown>> = [];
  walkNode(form, (current) => {
    const onClick = asRecord(current['on-click-action']);
    if (onClick && String(onClick.name ?? '') === actionName) {
      actions.push(onClick);
    }

    const onSelect = asRecord(current['on-select-action']);
    if (onSelect && String(onSelect.name ?? '') === actionName) {
      actions.push(onSelect);
    }
  });
  return actions;
};

const findCompleteActions = (form: Record<string, unknown>): Array<Record<string, unknown>> =>
  findActionsByName(form, 'complete');

const walkNode = (
  node: unknown,
  visitor: (current: Record<string, unknown>) => void,
): void => {
  if (Array.isArray(node)) {
    for (const item of node) {
      walkNode(item, visitor);
    }
    return;
  }

  const record = asRecord(node);
  if (!record) {
    return;
  }

  visitor(record);

  for (const value of Object.values(record)) {
    if (Array.isArray(value) || (value && typeof value === 'object')) {
      walkNode(value, visitor);
    }
  }
};

const normalizePayloadField = (
  key: string,
  value: unknown,
): FlowCompletionPayloadDefinition['payloadFields'][number] => {
  if (typeof value === 'string') {
    const formReference = value.match(/^\$\{form\.([^}]+)\}$/);
    if (formReference) {
      return {
        key,
        sourceType: 'form',
        sourceField: formReference[1],
        expression: value,
      };
    }

    // `${data.X}` é como o Flows encadeia estado entre telas: em flow multi-tela
    // as respostas das telas anteriores chegam ao `complete` assim, não como
    // `${form.X}`. Continua sendo `expression` (não muda o contrato), mas passa a
    // carregar `sourceField` para ser rastreável até a tela de origem.
    const dataReference = value.match(/^\$\{data\.([^}]+)\}$/);
    if (dataReference) {
      return {
        key,
        sourceType: 'expression',
        sourceField: dataReference[1],
        expression: value,
      };
    }

    if (value.startsWith('${') && value.endsWith('}')) {
      return {
        key,
        sourceType: 'expression',
        expression: value,
      };
    }

    return {
      key,
      sourceType: 'static',
      staticValue: value,
    };
  }

  return {
    key,
    sourceType: 'static',
    staticValue: JSON.stringify(value),
  };
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
