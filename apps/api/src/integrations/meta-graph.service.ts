import { Injectable } from '@nestjs/common';
import { CryptoService } from '../common/crypto.service';
import { extractVariableDescriptors, newId, nowIso } from '../database/helpers';
import {
  FlowCacheRecord,
  FlowCompletionPayloadDefinition,
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
      const completionPayloadDefinitions = await this.readCompletionPayloadDefinitions(assets);

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

  private async readCompletionPayloadDefinitions(
    assets: Record<string, unknown>[],
  ): Promise<FlowCompletionPayloadDefinition[]> {
    const assetUrl = assets.find(
      (asset) =>
        asset.asset_type === 'FLOW_JSON' && typeof asset.download_url === 'string',
    )?.download_url;
    if (typeof assetUrl !== 'string' || !assetUrl) {
      return [];
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      const response = await fetch(assetUrl, { signal: controller.signal }).finally(() =>
        clearTimeout(timeout),
      );
      if (!response.ok) {
        return [];
      }

      const flowJson = (await response.json()) as Record<string, unknown>;
      return extractCompletionPayloadDefinitions(flowJson);
    } catch {
      return [];
    }
  }
}

const extractCompletionPayloadDefinitions = (
  flowJson: Record<string, unknown>,
): FlowCompletionPayloadDefinition[] => {
  const screens = Array.isArray(flowJson.screens) ? flowJson.screens : [];
  const definitions: FlowCompletionPayloadDefinition[] = [];

  for (const screen of screens as Array<Record<string, unknown>>) {
    const screenId = String(screen.id ?? '');
    const forms = findForms(screen.layout);
    for (const form of forms) {
      const actions = findCompleteActions(form);
      for (const action of actions) {
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

        definitions.push({
          screenId,
          formName: typeof form.name === 'string' ? form.name : null,
          actionName: String(action.name ?? 'complete'),
          payloadFields,
        });
      }
    }
  }

  return definitions;
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

const findCompleteActions = (form: Record<string, unknown>): Array<Record<string, unknown>> => {
  const actions: Array<Record<string, unknown>> = [];
  walkNode(form, (current) => {
    const onClick = asRecord(current['on-click-action']);
    if (onClick && String(onClick.name ?? '') === 'complete') {
      actions.push(onClick);
    }

    const onSelect = asRecord(current['on-select-action']);
    if (onSelect && String(onSelect.name ?? '') === 'complete') {
      actions.push(onSelect);
    }
  });
  return actions;
};

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
