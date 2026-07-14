import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Public } from '../common/auth';
import { resolveClientScope } from '../common/scope';
import { ContactsService } from '../contacts/contacts.service';
import { UserSession } from '../database/types';
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
  constructor(private readonly contacts: ContactsService) {}

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
}
