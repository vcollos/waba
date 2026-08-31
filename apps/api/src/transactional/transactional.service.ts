import { randomBytes } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CampaignsService } from '../campaigns/campaigns.service';
import { integrationIdsForClient } from '../common/scope';
import { DatabaseService } from '../database/database.service';
import { hash, newId, normalizePhone, nowIso } from '../database/helpers';
import {
  CampaignMessageRecord,
  IntegrationRecord,
  TemplateCacheRecord,
} from '../database/types';
import { MetaApiError, MetaGraphService } from '../integrations/meta-graph.service';
import { CallbackUrlError, assertSafeCallbackUrl } from './callback-url';
import {
  buildTransactionalTemplatePayload,
  collectMissingVariables,
  redactTransactionalPayload,
} from './transactional.payload';

// Canal transacional só aceita templates utilitários/autenticação. MARKETING é
// bloqueado (evita usar OTP/token como veículo de marketing sem opt-in).
const ALLOWED_TEMPLATE_CATEGORIES = new Set(['UTILITY', 'AUTHENTICATION']);

export interface TransactionalDispatchInput {
  apiClientId: string;
  integrationId?: string | null;
  template: string;
  language?: string | null;
  to: string;
  variables?: Record<string, string>;
  idempotencyKey?: string | null;
  callbackUrl?: string | null;
}

export interface TransactionalDispatchResult {
  id: string;
  providerMessageId: string | null;
  status: CampaignMessageRecord['status'];
  to: string;
  /** Segredo do callback exibido UMA vez (só quando gerado neste disparo). */
  callbackSecret?: string;
}

@Injectable()
export class TransactionalService {
  private readonly logger = new Logger(TransactionalService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly metaGraph: MetaGraphService,
    private readonly campaigns: CampaignsService,
  ) {}

  async dispatch(input: TransactionalDispatchInput): Promise<TransactionalDispatchResult> {
    const variables = input.variables ?? {};

    // 0. Valida destino cedo (nunca loga variables/código).
    const { phoneE164, error: phoneError } = normalizePhone(input.to);
    if (phoneError) {
      throw new BadRequestException(phoneError);
    }

    // callback_url: anti-SSRF já na ENTRADA (revalidado de novo no envio).
    const callbackUrl = (input.callbackUrl ?? '').trim() || null;
    if (callbackUrl) {
      try {
        await assertSafeCallbackUrl(callbackUrl);
      } catch (error) {
        if (error instanceof CallbackUrlError) {
          throw new BadRequestException(error.message);
        }
        throw error;
      }
    }

    const idempotencyKey = (input.idempotencyKey ?? '').trim() || null;

    // 1. Resolve a integração do tenant.
    const integration = await this.resolveIntegration(input.apiClientId, input.integrationId);

    // 2. Idempotência: replay sem reenviar.
    if (idempotencyKey) {
      const existing = await this.database.findTransactionalDispatchByIdempotencyKey(
        input.apiClientId,
        idempotencyKey,
      );
      if (existing) {
        return this.replayResult(existing.campaignMessageId, phoneE164);
      }
    }

    // 3. Resolve o template aprovado e restringe a categoria (sem MARKETING).
    const template = await this.resolveTemplate(integration.id, input.template, input.language);
    const category = String(template.category).toUpperCase();
    if (!ALLOWED_TEMPLATE_CATEGORIES.has(category)) {
      throw new BadRequestException(
        `Categoria "${category}" não permitida no canal transacional (use UTILITY ou AUTHENTICATION)`,
      );
    }

    // 3b. Placeholders obrigatórios: falha clara ANTES de chamar a Meta.
    const missing = collectMissingVariables(template, variables);
    if (missing.length > 0) {
      throw new BadRequestException({
        message: 'Variáveis obrigatórias do template ausentes',
        missing,
      });
    }

    // 3c. Supressão de opt-out do tenant para o destino.
    if (await this.isOptedOut(input.apiClientId, phoneE164)) {
      throw new ConflictException({ message: 'Destino descadastrado (opt-out)', reason: 'opted_out' });
    }

    // 4. Campanha-canal de serviço (singleton por integração).
    const serviceCampaignId = await this.ensureServiceCampaign(integration.id, input.apiClientId);

    // 5. Monta o payload transacional (real, apenas em memória para o envio).
    const payload = buildTransactionalTemplatePayload(template, phoneE164, variables);

    // 6. Envio SÍNCRONO à Meta.
    let providerMessageId: string | null = null;
    try {
      const response = await this.metaGraph.sendMessage(integration, payload);
      providerMessageId = Array.isArray(response.messages)
        ? String((response.messages[0] as Record<string, unknown>)?.id ?? '') || null
        : null;
      // 7 + 8 + 9 dependem de sucesso — persistimos abaixo com o response.
      return await this.persistAccepted({
        apiClientId: input.apiClientId,
        integration,
        serviceCampaignId,
        phoneE164,
        payload,
        providerMessageId,
        response,
        idempotencyKey,
        callbackUrl,
      });
    } catch (error) {
      if (error instanceof MetaApiError) {
        // Loga só código/título — nunca o payload (contém o código OTP).
        this.logger.warn(
          `Meta rejeitou disparo transacional: code=${error.code ?? 'n/a'} title=${error.message}`,
        );
        if (error.code) {
          throw new UnprocessableEntityException({
            message: 'Falha ao enviar mensagem à Meta',
            metaCode: error.code,
            metaMessage: error.message,
          });
        }
        throw new BadGatewayException({
          message: 'Falha de comunicação com a Meta',
          metaMessage: error.message,
        });
      }
      throw error;
    }
  }

  private async persistAccepted(args: {
    apiClientId: string;
    integration: IntegrationRecord;
    serviceCampaignId: string;
    phoneE164: string;
    payload: Record<string, unknown>;
    providerMessageId: string | null;
    response: Record<string, unknown>;
    idempotencyKey: string | null;
    callbackUrl: string | null;
  }): Promise<TransactionalDispatchResult> {
    const now = nowIso();
    const messageId = newId();
    // contactId sintético (sem PII e sem criar contato real); a coluna é NOT NULL.
    const contactId = `txn:${hash(args.phoneE164)}`;

    // Persistimos o payload REDIGIDO: o código OTP/token nunca toca o banco
    // (`record_json`) nem o `payloadHash`. O payload real já foi enviado à Meta.
    const redactedPayload = redactTransactionalPayload(args.payload);
    const message: CampaignMessageRecord = {
      id: messageId,
      campaignId: args.serviceCampaignId,
      contactId,
      phoneE164: args.phoneE164,
      status: 'accepted',
      payload: redactedPayload,
      payloadHash: hash(JSON.stringify(redactedPayload)),
      flowToken: null,
      providerMessageId: args.providerMessageId,
      attemptCount: 1,
      nextAttemptAt: null,
      lastAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.database.saveCampaignMessageInDatabase(message);

    await this.database.saveMessageEventInDatabase({
      id: newId(),
      campaignMessageId: messageId,
      providerMessageId: args.providerMessageId,
      eventType: 'send.accepted',
      status: 'accepted',
      payload: args.response,
      occurredAt: now,
      receivedAt: now,
      dedupeKey: `accepted:${args.providerMessageId || messageId}`,
    });

    // Segredo de callback gerado só quando há URL (retornado ao cliente para
    // ele validar a assinatura X-Waba-Signature).
    const callbackSecret = args.callbackUrl ? `whsec_${randomBytes(24).toString('hex')}` : null;
    try {
      await this.database.insertTransactionalDispatch({
        id: newId(),
        clientId: args.apiClientId,
        integrationId: args.integration.id,
        campaignMessageId: messageId,
        idempotencyKey: args.idempotencyKey,
        callbackUrl: args.callbackUrl,
        callbackSecret,
        callbackStatus: null,
        callbackAttempts: 0,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      // Corrida rara: outra requisição com a mesma idempotencyKey inseriu entre
      // o pré-check e aqui (violação da UNIQUE). Já enviamos — devolvemos o
      // resultado canônico sem 500. Há uma pequena janela de envio duplicado
      // sob concorrência exata (aceitável para OTP best-effort).
      if (isUniqueViolation(error) && args.idempotencyKey) {
        return this.replayResult(
          (await this.database.findTransactionalDispatchByIdempotencyKey(
            args.apiClientId,
            args.idempotencyKey,
          ))?.campaignMessageId ?? messageId,
          args.phoneE164,
        );
      }
      throw error;
    }

    await this.campaigns.refreshCampaignSummary(args.serviceCampaignId);

    return {
      id: messageId,
      providerMessageId: args.providerMessageId,
      status: 'accepted',
      to: args.phoneE164,
      // Exibição única: o cliente guarda para validar o X-Waba-Signature.
      ...(callbackSecret ? { callbackSecret } : {}),
    };
  }

  /** True se o número está descadastrado (opt-out) no tenant. */
  private async isOptedOut(clientId: string, phoneE164: string): Promise<boolean> {
    const phoneHash = hash(phoneE164.replace(/^\+/, ''));
    const rows = await this.database.postgresQuery<{ exists: boolean }>(
      `SELECT 1 AS exists
       FROM contacts
       WHERE phone_hash = $1
         AND COALESCE(client_id, '') = COALESCE($2, '')
         AND is_opted_out = true
       LIMIT 1`,
      [phoneHash, clientId],
    );
    return rows.length > 0;
  }

  private async replayResult(
    campaignMessageId: string,
    fallbackPhone: string,
  ): Promise<TransactionalDispatchResult> {
    const message = await this.database.findCampaignMessageByIdInDatabase(campaignMessageId);
    return {
      id: campaignMessageId,
      providerMessageId: message?.providerMessageId ?? null,
      status: message?.status ?? 'accepted',
      to: message?.phoneE164 ?? fallbackPhone,
    };
  }

  private async resolveIntegration(
    apiClientId: string,
    integrationId?: string | null,
  ): Promise<IntegrationRecord> {
    const [all, links] = await Promise.all([
      this.database.listIntegrationsInDatabase(),
      this.database.listClientIntegrationsInDatabase(),
    ]);
    // Vínculo N:N: o tenant enxerga toda conta WABA vinculada a ele, inclusive
    // uma compartilhada com outro tenant.
    const allowed = integrationIdsForClient(links, apiClientId);
    const tenantIntegrations = all.filter(
      (integration) => allowed.has(integration.id) && integration.status === 'active',
    );

    if (tenantIntegrations.length === 0) {
      throw new BadRequestException('Tenant sem integração WABA ativa');
    }

    const requestedId = (integrationId ?? '').trim() || null;
    if (requestedId) {
      const match = tenantIntegrations.find((integration) => integration.id === requestedId);
      if (!match) {
        throw new BadRequestException('integrationId não pertence ao tenant ou não está ativa');
      }
      return match;
    }

    if (tenantIntegrations.length > 1) {
      throw new BadRequestException(
        'Tenant tem múltiplas integrações ativas; informe integrationId',
      );
    }

    return tenantIntegrations[0];
  }

  private async resolveTemplate(
    integrationId: string,
    templateName: string,
    language?: string | null,
  ): Promise<TemplateCacheRecord> {
    const templates = await this.database.listTemplatesInDatabase(integrationId);
    const lang = (language ?? '').trim() || null;

    const byName = templates.filter((template) => template.name === templateName);
    if (byName.length === 0) {
      throw new NotFoundException(`Template "${templateName}" não encontrado`);
    }

    const candidates = lang
      ? byName.filter((template) => template.languageCode === lang)
      : byName;
    if (candidates.length === 0) {
      throw new NotFoundException(
        `Template "${templateName}" não disponível no idioma "${lang}"`,
      );
    }

    const approved = candidates.filter(
      (template) => String(template.status).toUpperCase() === 'APPROVED',
    );
    if (approved.length === 0) {
      throw new BadRequestException(`Template "${templateName}" não está aprovado`);
    }

    if (approved.length > 1 && !lang) {
      throw new BadRequestException(
        `Template "${templateName}" existe em múltiplos idiomas; informe language`,
      );
    }

    return approved[0];
  }

  /**
   * Campanha-canal de serviço singleton por integração (id estável `svc:<id>`).
   * Fica FORA da seleção do poller: nasce e permanece com status 'completed'
   * (o `DispatchService` só considera 'queued'/'sending'), então nunca é
   * reivindicada nem sofre refresh a cada tick.
   */
  private async ensureServiceCampaign(integrationId: string, clientId: string): Promise<string> {
    const id = `svc:${integrationId}`;
    const state = await this.database.readMeta();
    if (state.campaigns.some((campaign) => campaign.id === id)) {
      return id;
    }

    const now = nowIso();
    await this.database.write((draft) => {
      if (draft.campaigns.some((campaign) => campaign.id === id)) {
        return;
      }
      draft.campaigns.push({
        id,
        clientId,
        integrationId,
        name: '[serviço] Disparo transacional',
        mode: 'template',
        templateCacheId: null,
        flowCacheId: null,
        listId: '',
        parameterMapping: {},
        audience: {
          mode: 'all',
          orderMode: 'field',
          orderDirection: 'asc',
          resendPolicy: 'all',
        },
        audienceSnapshot: {
          listMembersTotal: 0,
          eligibleCount: 0,
          afterResendFilterCount: 0,
          excludedByResendPolicy: 0,
          selectedCount: 0,
        },
        sendRateMps: 0,
        status: 'completed',
        summary: {
          total: 0,
          pending: 0,
          accepted: 0,
          sent: 0,
          delivered: 0,
          read: 0,
          failed: 0,
          skipped: 0,
        },
        createdAt: now,
        updatedAt: now,
      });
    });

    return id;
  }
}

const isUniqueViolation = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && (error as { code?: string }).code === '23505');
