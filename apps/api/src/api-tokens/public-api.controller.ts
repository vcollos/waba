import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../common/auth';
import { resolveClientScope } from '../common/scope';
import { ContactsService } from '../contacts/contacts.service';
import { UserSession } from '../database/types';
import { TransactionalRateLimiter } from '../transactional/transactional.rate-limiter';
import { TransactionalService } from '../transactional/transactional.service';
import { ApiTokenGuard } from './api-token.guard';

interface ApiRequest {
  user: UserSession;
  apiClientId: string;
}

interface IngestContact {
  name?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string | null;
  category?: string | null;
}

/**
 * API pública de ingestão de contatos por token de tenant.
 * Autenticação: Authorization: Bearer wba_...  (ApiTokenGuard).
 * @Public() apenas dispensa o JWT global; o ApiTokenGuard impõe o token.
 */
@Public()
@Controller('public/v1')
@UseGuards(ApiTokenGuard)
export class PublicApiController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly transactional: TransactionalService,
    private readonly rateLimiter: TransactionalRateLimiter,
  ) {}

  @Get('lists')
  lists(@Req() request: ApiRequest) {
    return this.contacts.listLists(resolveClientScope(request.user));
  }

  @Post('lists')
  createList(@Body() body: { name?: string; description?: string }, @Req() request: ApiRequest) {
    return this.contacts.createList(
      { name: body.name ?? 'Lista via API', description: body.description, sourceType: 'api' },
      request.user,
    );
  }

  @Post('lists/:id/contacts')
  ingest(
    @Param('id') id: string,
    @Body() body: { contacts?: IngestContact[] },
    @Req() request: ApiRequest,
  ) {
    return this.contacts.apiIngestContacts(id, body.contacts ?? [], request.apiClientId);
  }

  /**
   * Disparo transacional (OTP / token / assinatura de venda). Envio síncrono à
   * Meta; idempotência via header `Idempotency-Key`. O tenant vem do token
   * (request.apiClientId) — nunca do corpo.
   */
  @Post('messages')
  sendTransactional(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body()
    body: {
      to?: string;
      template?: string;
      language?: string;
      variables?: Record<string, string>;
      integrationId?: string;
      callbackUrl?: string;
    },
    @Req() request: ApiRequest,
  ) {
    this.rateLimiter.check(request.apiClientId);

    const to = (body.to ?? '').trim();
    const template = (body.template ?? '').trim();
    if (!to) {
      throw new BadRequestException('Campo "to" é obrigatório');
    }
    if (!template) {
      throw new BadRequestException('Campo "template" é obrigatório');
    }

    return this.transactional.dispatch({
      apiClientId: request.apiClientId,
      integrationId: body.integrationId,
      template,
      language: body.language,
      to,
      variables: body.variables ?? {},
      idempotencyKey: (idempotencyKey ?? '').trim() || null,
      callbackUrl: body.callbackUrl,
    });
  }
}
