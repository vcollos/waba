import { Body, Controller, Get, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { Roles } from '../common/roles';
import { RolesGuard } from '../common/roles.guard';
import { UserSession } from '../database/types';
import { ClientInput, ClientsService } from './clients.service';

@Controller('clients')
export class ClientsController {
  constructor(private readonly clientsService: ClientsService) {}

  @Get()
  list(@Req() request: { user: UserSession }) {
    return this.clientsService.list(request.user);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('super_admin', 'admin')
  create(@Body() body: ClientInput) {
    return this.clientsService.create(body);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles('super_admin', 'admin')
  update(@Param('id') id: string, @Body() body: ClientInput) {
    return this.clientsService.update(id, body);
  }

  // Integrações que este tenant pode usar. O conjunto enviado é o final e vale
  // SÓ para este cliente — salvar aqui nunca desvincula outro tenant.
  @Put(':id/integrations')
  @UseGuards(RolesGuard)
  @Roles('super_admin', 'admin')
  setIntegrations(
    @Param('id') id: string,
    @Body() body: { integrationIds?: string[] },
    @Req() request: { user: UserSession },
  ) {
    return this.clientsService.setIntegrations(id, body.integrationIds ?? [], request.user);
  }
}
