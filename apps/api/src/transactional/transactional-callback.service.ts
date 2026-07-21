import { createHmac } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { TransactionalDispatchRecord } from '../database/types';
import {
  CallbackUrlError,
  SafeCallbackTarget,
  assertSafeCallbackUrl,
  postJsonToSafeTarget,
} from './callback-url';

export interface TransactionalCallbackEvent {
  messageId: string;
  idempotencyKey: string | null;
  to: string;
  status: string;
  providerMessageId: string | null;
  occurredAt: string;
  error?: { code: string | null; title: string | null };
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Callback de saída: entrega o status da mensagem transacional ao sistema do
 * cliente. Best-effort e assinado (HMAC) quando há segredo. Fora do caminho
 * crítico do webhook (o chamador usa `void ...catch`).
 */
@Injectable()
export class TransactionalCallbackService {
  private readonly logger = new Logger(TransactionalCallbackService.name);

  constructor(private readonly database: DatabaseService) {}

  async notify(
    dispatch: TransactionalDispatchRecord,
    event: TransactionalCallbackEvent,
  ): Promise<void> {
    const url = dispatch.callbackUrl;
    if (!url) {
      return;
    }

    // Revalida SEMPRE antes do envio (a URL vem do banco) e resolve/pina o IP
    // público — mitiga SSRF e DNS-rebinding entre a gravação e o disparo.
    let target: SafeCallbackTarget;
    try {
      target = await assertSafeCallbackUrl(url);
    } catch (error) {
      if (error instanceof CallbackUrlError) {
        await this.database
          .updateTransactionalCallback(dispatch.id, {
            status: 'skipped_unsafe_url',
            attempts: dispatch.callbackAttempts,
          })
          .catch(() => undefined);
        return;
      }
      throw error;
    }

    const body = JSON.stringify(event);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (dispatch.callbackSecret) {
      const signature = createHmac('sha256', dispatch.callbackSecret).update(body).digest('hex');
      headers['X-Waba-Signature'] = `sha256=${signature}`;
    }

    let attempts = dispatch.callbackAttempts;
    let lastStatus: string | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      attempts += 1;
      try {
        lastStatus = await postJsonToSafeTarget(target, headers, body, REQUEST_TIMEOUT_MS);
        if (lastStatus.startsWith('2')) {
          break;
        }
      } catch {
        lastStatus = 'network_error';
      }

      if (attempt < MAX_ATTEMPTS - 1) {
        await delay(BASE_BACKOFF_MS * 2 ** attempt);
      }
    }

    if (lastStatus && !lastStatus.startsWith('2')) {
      // Nunca loga o corpo (contém o destino); só o resultado.
      this.logger.warn(
        `Callback transacional ${dispatch.id} falhou após ${attempts} tentativa(s): ${lastStatus}`,
      );
    }

    await this.database
      .updateTransactionalCallback(dispatch.id, { status: lastStatus, attempts })
      .catch(() => undefined);
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
