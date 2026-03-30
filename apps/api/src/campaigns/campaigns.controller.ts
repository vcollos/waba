import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { CampaignsService, CreateCampaignInput } from './campaigns.service';
import { UserSession } from '../database/types';

@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaignsService: CampaignsService) {}

  @Get()
  list() {
    return this.campaignsService.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.campaignsService.getCampaign(id);
  }

  @Post()
  create(@Body() body: CreateCampaignInput, @Req() request: { user: UserSession }) {
    return this.campaignsService.create(body, request.user);
  }

  @Post(':id/start')
  start(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.campaignsService.start(id, request.user);
  }

  @Post(':id/pause')
  pause(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.campaignsService.pause(id, request.user);
  }

  @Post(':id/resume')
  resume(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.campaignsService.resume(id, request.user);
  }

  @Post(':id/retry-failed')
  retryFailed(@Param('id') id: string, @Req() request: { user: UserSession }) {
    return this.campaignsService.retryFailed(id, request.user);
  }
}
