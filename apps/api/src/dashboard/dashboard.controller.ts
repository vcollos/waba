import { Controller, Get, Query, Req } from '@nestjs/common';
import { UserSession } from '../database/types';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('summary')
  summary(
    @Req() request: { user: UserSession },
    @Query('clientId') clientId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.dashboardService.summary(request.user, {
      clientId: clientId || null,
      from: from || null,
      to: to || null,
    });
  }
}
