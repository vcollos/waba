import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Roles } from '../common/roles';
import { RolesGuard } from '../common/roles.guard';
import { CampaignsService, CreateCampaignInput } from './campaigns.service';
import { UserSession } from '../database/types';

/** Papéis que podem operar campanhas (todos menos viewer, que só lê). */
const CAMPAIGN_WRITE_ROLES = ['super_admin', 'admin', 'client_admin', 'operator'] as const;

@Controller('campaigns')
@UseGuards(RolesGuard)
export class CampaignsController {
  constructor(private readonly campaignsService: CampaignsService) {}

  @Get()
  list(@Req() request: { user: UserSession }, @Query('clientId') clientId?: string) {
    return this.campaignsService.list(request.user, clientId);
  }

  @Get(':id')
  get(
    @Param('id') id: string,
    @Req() request: { user: UserSession },
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.campaignsService.getCampaign(
      id,
      {
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      },
      request.user,
    );
  }

  @Post()
  @Roles(...CAMPAIGN_WRITE_ROLES)
  create(@Body() body: CreateCampaignInput, @Req() request: { user: UserSession }) {
    return this.campaignsService.create(body, request.user);
  }

  @Post(':id/start')
  @Roles(...CAMPAIGN_WRITE_ROLES)
  start(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.campaignsService.start(id, request.user);
  }

  @Post(':id/pause')
  @Roles(...CAMPAIGN_WRITE_ROLES)
  pause(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.campaignsService.pause(id, request.user);
  }

  @Post(':id/resume')
  @Roles(...CAMPAIGN_WRITE_ROLES)
  resume(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.campaignsService.resume(id, request.user);
  }

  @Post(':id/retry-failed')
  @Roles(...CAMPAIGN_WRITE_ROLES)
  retryFailed(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.campaignsService.retryFailed(id, request.user);
  }

  @Post(':id/retry-unanswered-flow')
  @Roles(...CAMPAIGN_WRITE_ROLES)
  retryUnansweredFlow(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.campaignsService.retryUnansweredFlow(id, request.user);
  }

  @Delete(':id')
  @Roles(...CAMPAIGN_WRITE_ROLES)
  remove(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.campaignsService.removeDraft(id, request.user);
  }
}
