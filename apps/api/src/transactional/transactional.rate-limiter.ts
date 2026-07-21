import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

// Limites por token/tenant. O repo não tem throttler; este limitador é
// in-memory (janela deslizante), suficiente por instância. Ajuste aqui.
export const RATE_LIMIT_PER_SECOND = 10;
export const RATE_LIMIT_PER_MINUTE = 300;

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;

/**
 * Limitador in-memory por chave (apiClientId). Duas janelas deslizantes:
 * 10 req/s e 300 req/min. Lança 429 ao estourar. Estado por processo — em
 * múltiplas instâncias o limite é por instância (aceitável como guarda de OTP).
 */
@Injectable()
export class TransactionalRateLimiter {
  private readonly hits = new Map<string, number[]>();

  check(key: string): void {
    const now = Date.now();
    const timestamps = (this.hits.get(key) ?? []).filter((ts) => now - ts < MINUTE_MS);

    const inLastSecond = timestamps.filter((ts) => now - ts < SECOND_MS).length;
    if (inLastSecond >= RATE_LIMIT_PER_SECOND || timestamps.length >= RATE_LIMIT_PER_MINUTE) {
      // Reescreve a janela podada mesmo ao rejeitar (evita crescer sem limite).
      this.hits.set(key, timestamps);
      throw new HttpException('Limite de disparos excedido', HttpStatus.TOO_MANY_REQUESTS);
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);
  }
}
