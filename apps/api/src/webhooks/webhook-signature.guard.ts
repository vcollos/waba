import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  RawBodyRequest,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { IntegrationsService } from '../integrations/integrations.service';

const SIGNATURE_HEADER = 'x-hub-signature-256';
const SIGNATURE_PREFIX = 'sha256=';
// SHA-256 em hex => 64 chars.
const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/**
 * Verifica a assinatura HMAC-SHA256 do webhook da Meta ANTES de processar.
 *
 * Regras (fail-closed):
 * - Header `X-Hub-Signature-256` ausente/malformado => 401.
 * - Resolve a(s) integração(ões) pelo corpo (waba_id em `entry[].id` e/ou
 *   phone_number_id em `changes[].value.metadata`) e usa o appSecret dela.
 * - Integração desconhecida OU sem appSecret => 401 (NUNCA processa sem validar).
 * - Assinatura calculada sobre os BYTES CRUS (`req.rawBody`) comparada com a
 *   recebida via `timingSafeEqual`; tamanhos diferentes => rejeita sem comparar.
 * - Qualquer erro de parsing/decrypt vira 401 (nunca 500). Não loga segredo nem
 *   assinatura.
 */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  constructor(private readonly integrationsService: IntegrationsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RawBodyRequest<Request>>();

    try {
      const header = request.headers[SIGNATURE_HEADER];
      const signature = Array.isArray(header) ? header[0] : header;
      if (!signature || !signature.startsWith(SIGNATURE_PREFIX)) {
        throw new UnauthorizedException('Missing webhook signature');
      }

      const receivedHex = signature.slice(SIGNATURE_PREFIX.length).trim();
      if (!HEX_SHA256.test(receivedHex)) {
        throw new UnauthorizedException('Malformed webhook signature');
      }

      const rawBody = request.rawBody;
      if (!rawBody || rawBody.length === 0) {
        throw new UnauthorizedException('Missing webhook raw body');
      }

      const refs = extractWebhookRefs(request.body);
      const secrets = await this.integrationsService.resolveWebhookAppSecrets(refs);
      if (secrets.length === 0) {
        // Integração desconhecida ou sem appSecret configurado => fail-closed.
        throw new UnauthorizedException('Unknown webhook integration');
      }

      const received = Buffer.from(receivedHex, 'hex');
      const valid = secrets.some((secret) => {
        const expected = createHmac('sha256', secret).update(rawBody).digest();
        return (
          expected.length === received.length && timingSafeEqual(expected, received)
        );
      });
      if (!valid) {
        throw new UnauthorizedException('Invalid webhook signature');
      }

      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      // Nunca vaza 500 (não dá pista ao atacante nem derruba o handler).
      throw new UnauthorizedException('Webhook signature verification failed');
    }
  }
}

/**
 * Extrai as referências de integração do corpo já parseado do webhook:
 * waba_id em `entry[].id` e phone_number_id em `changes[].value.metadata`.
 */
export const extractWebhookRefs = (
  body: unknown,
): { wabaIds: string[]; phoneNumberIds: string[] } => {
  const wabaIds = new Set<string>();
  const phoneNumberIds = new Set<string>();

  const payload = asRecord(body);
  const entries = Array.isArray(payload?.entry) ? payload!.entry : [];
  for (const rawEntry of entries) {
    const entry = asRecord(rawEntry);
    if (!entry) {
      continue;
    }
    if (entry.id != null && String(entry.id).trim()) {
      wabaIds.add(String(entry.id));
    }
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const rawChange of changes) {
      const change = asRecord(rawChange);
      const value = asRecord(change?.value) ?? {};
      const metadata = asRecord(value.metadata) ?? {};
      if (metadata.phone_number_id != null && String(metadata.phone_number_id).trim()) {
        phoneNumberIds.add(String(metadata.phone_number_id));
      }
    }
  }

  return { wabaIds: [...wabaIds], phoneNumberIds: [...phoneNumberIds] };
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
