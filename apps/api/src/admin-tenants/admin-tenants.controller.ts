import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { Roles } from '../common/roles';
import { RolesGuard } from '../common/roles.guard';
import { UserSession } from '../database/types';
import { AdminTenantsService } from './admin-tenants.service';

// Organização de dados entre tenants: exclusivo da administração Collos.
@Controller('admin/tenants')
@UseGuards(RolesGuard)
@Roles('super_admin', 'admin')
export class AdminTenantsController {
  constructor(private readonly adminTenants: AdminTenantsService) {}

  @Get('overview')
  overview() {
    return this.adminTenants.overview();
  }

  @Post('transfer/lists')
  transferLists(
    @Body() body: { listIds?: string[]; clientId?: string | null },
    @Req() request: { user: UserSession },
  ) {
    return this.adminTenants.transferLists(body.listIds ?? [], body.clientId ?? null, request.user);
  }

  @Post('transfer/campaigns')
  transferCampaigns(
    @Body() body: { campaignIds?: string[]; clientId?: string | null },
    @Req() request: { user: UserSession },
  ) {
    return this.adminTenants.transferCampaigns(
      body.campaignIds ?? [],
      body.clientId ?? null,
      request.user,
    );
  }
}
