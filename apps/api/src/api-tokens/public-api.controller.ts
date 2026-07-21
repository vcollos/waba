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
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Public } from '../common/auth';
import { resolveClientScope } from '../common/scope';
import { ContactsService } from '../contacts/contacts.service';
import { UserSession } from '../database/types';
import { TransactionalRateLimiter } from '../transactional/transactional.rate-limiter';
import { TransactionalService } from '../transactional/transactional.service';
import {
  SendMessageDto,
  SendMessageResponseDto,
} from '../transactional/dto/send-transactional.dto';
import {
  CreateListDto,
  IngestContactsDto,
  IngestContactsResponseDto,
} from './dto/public-lists.dto';
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
@ApiTags('API Pública (por token)')
@ApiBearerAuth('token')
@ApiUnauthorizedResponse({
  description: 'Token ausente, inválido ou revogado (Authorization: Bearer wba_...).',
})
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
  @ApiOperation({
    summary: 'Lista as listas de contatos do tenant',
    description:
      'Retorna as listas de contatos pertencentes ao tenant do token. O escopo é sempre derivado do token — nenhum client_id é aceito do cliente.',
  })
  lists(@Req() request: ApiRequest) {
    return this.contacts.listLists(resolveClientScope(request.user));
  }

  @Post('lists')
  @ApiOperation({
    summary: 'Cria uma lista de contatos',
    description:
      'Cria uma nova lista de contatos no tenant do token (sourceType = api). O tenant vem do token.',
  })
  @ApiBody({ type: CreateListDto })
  @ApiCreatedResponse({ description: 'Lista criada.' })
  createList(@Body() body: { name?: string; description?: string }, @Req() request: ApiRequest) {
    return this.contacts.createList(
      { name: body.name ?? 'Lista via API', description: body.description, sourceType: 'api' },
      request.user,
    );
  }

  @Post('lists/:id/contacts')
  @ApiOperation({
    summary: 'Ingere contatos em uma lista (lote)',
    description:
      'Insere/atualiza até 5000 contatos na lista indicada. A lista precisa pertencer ao tenant do token. Telefones inválidos são contados em "invalid".',
  })
  @ApiBody({ type: IngestContactsDto })
  @ApiCreatedResponse({
    description: 'Resumo da ingestão (recebidos/inseridos/atualizados/ignorados/inválidos).',
    type: IngestContactsResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Corpo vazio ou acima de 5000 contatos.' })
  @ApiResponse({ status: 404, description: 'Lista não encontrada no tenant do token.' })
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
  @ApiOperation({
    summary: 'Dispara uma mensagem transacional (OTP / token / assinatura)',
    description:
      'Envio síncrono à Meta usando um template aprovado (UTILITY ou AUTHENTICATION). Autentique com Authorization: Bearer wba_... — o tenant vem sempre do token, nunca do corpo. Use o header Idempotency-Key para evitar reenvio em retries.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Chave de idempotência: repetições com a mesma chave devolvem o disparo original sem reenviar.',
    example: 'req-2026-07-21-0001',
  })
  @ApiBody({ type: SendMessageDto })
  @ApiOkResponse({ description: 'Disparo aceito.', type: SendMessageResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'Requisição inválida: "to"/"template" ausente, telefone fora de E.164, variáveis obrigatórias faltando, template não aprovado ou categoria MARKETING, callbackUrl insegura, ou tenant sem/ com múltiplas integrações ativas.',
  })
  @ApiConflictResponse({ description: 'Destino descadastrado (opt-out) no tenant.' })
  @ApiResponse({ status: 422, description: 'Meta rejeitou o envio (metaCode/metaMessage).' })
  @ApiResponse({ status: 429, description: 'Rate limit do canal transacional excedido.' })
  @ApiResponse({ status: 502, description: 'Falha de comunicação com a Meta.' })
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
