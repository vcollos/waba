import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { UserSession } from '../database/types';
import { ApiTokensService } from './api-tokens.service';

/**
 * Autentica as rotas públicas de ingestão por um token de API do tenant
 * (Authorization: Bearer wba_...). Resolve o clientId do token e injeta uma
 * sessão sintética escopada a esse tenant em request.user, para que os serviços
 * reutilizem a mesma lógica de escopo (writeClientId/resolveClientScope).
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(private readonly apiTokens: ApiTokensService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers?.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token de API ausente');
    }

    const resolved = await this.apiTokens.resolveClientId(header.slice('Bearer '.length));
    if (!resolved) {
      throw new UnauthorizedException('Token de API inválido ou revogado');
    }

    const session: UserSession = {
      id: `api-token:${resolved.tokenId}`,
      email: 'api@token',
      name: 'API Token',
      role: 'client_admin',
      clientIds: [resolved.clientId],
    };
    request.user = session;
    request.apiClientId = resolved.clientId;
    return true;
  }
}
