import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Roles } from '../common/roles';
import { RolesGuard } from '../common/roles.guard';
import { UserSession } from '../database/types';
import { ApiTokensService } from './api-tokens.service';

// Gestão de tokens de API: Collos e o admin do próprio tenant.
@Controller('api-tokens')
@UseGuards(RolesGuard)
@Roles('super_admin', 'admin', 'client_admin')
export class ApiTokensController {
  constructor(private readonly apiTokens: ApiTokensService) {}

  @Get()
  list(@Req() request: { user: UserSession }, @Query('clientId') clientId?: string) {
    return this.apiTokens.list(request.user, clientId);
  }

  @Post()
  create(
    @Body() body: { name?: string; clientId?: string | null },
    @Req() request: { user: UserSession },
  ) {
    return this.apiTokens.create({ name: body.name ?? 'Token de API', clientId: body.clientId }, request.user);
  }

  @Post(':id/revoke')
  revoke(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.apiTokens.revoke(id, request.user);
  }
}
