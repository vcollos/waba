import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Roles } from '../common/roles';
import { RolesGuard } from '../common/roles.guard';
import { IntegrationsService, SaveIntegrationInput } from './integrations.service';
import { UserSession } from '../database/types';

@Controller('integrations')
@UseGuards(RolesGuard)
export class IntegrationsController {
  constructor(private readonly integrationsService: IntegrationsService) {}

  // Leitura: qualquer papel autenticado, escopado por tenant (o wizard de
  // campanha e a tela de Modelos precisam listar as integrações do cliente).
  @Get()
  list(@Req() request: { user: UserSession }) {
    return this.integrationsService.list(request.user);
  }

  // Criar/editar integração e segredos: apenas Collos.
  @Post()
  @Roles('super_admin', 'admin')
  save(@Body() body: SaveIntegrationInput, @Req() request: { user: UserSession }) {
    return this.integrationsService.save(body, request.user);
  }

  // Testar conexão: apenas Collos.
  @Post(':id/test')
  @Roles('super_admin', 'admin')
  test(@Param('id') id: string) {
    return this.integrationsService.testConnection(id);
  }

  // Designar a integração a um cliente (ou desvincular): apenas Collos.
  @Patch(':id/client')
  @Roles('super_admin', 'admin')
  setClient(
    @Param('id') id: string,
    @Body() body: { clientId?: string | null },
    @Req() request: { user: UserSession },
  ) {
    return this.integrationsService.setClient(id, body.clientId ?? null, request.user);
  }

  // Sincronizar modelos/flows: Collos e papéis operacionais do cliente
  // (client_admin, operator) — sempre escopado à integração do próprio tenant.
  @Post(':id/sync/templates')
  @Roles('super_admin', 'admin', 'client_admin', 'operator')
  syncTemplates(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.integrationsService.syncTemplates(id, request.user);
  }

  @Post(':id/sync/flows')
  @Roles('super_admin', 'admin', 'client_admin', 'operator')
  syncFlows(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.integrationsService.syncFlows(id, request.user);
  }
}
