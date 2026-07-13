import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Roles } from '../common/roles';
import { RolesGuard } from '../common/roles.guard';
import { IntegrationsService, SaveIntegrationInput } from './integrations.service';
import { UserSession } from '../database/types';

@Controller('integrations')
@UseGuards(RolesGuard)
@Roles('super_admin', 'admin')
export class IntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  @Get()
  list() {
    return this.integrationsService.list();
  }

  @Post()
  save(
    @Body() body: SaveIntegrationInput,
    @Req() request: { user: UserSession },
  ) {
    return this.integrationsService.save(body, request.user);
  }

  @Post(':id/test')
  test(@Param('id') id: string) {
    return this.integrationsService.testConnection(id);
  }

  @Post(':id/sync/templates')
  syncTemplates(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.integrationsService.syncTemplates(id, request.user);
  }

  @Post(':id/sync/flows')
  syncFlows(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.integrationsService.syncFlows(id, request.user);
  }
}
