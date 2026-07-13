import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../common/roles';
import { RolesGuard } from '../common/roles.guard';
import { AuditReadService } from './audit-read.service';

@Controller('audit')
@UseGuards(RolesGuard)
@Roles('super_admin', 'admin')
export class AuditController {
  constructor(private readonly auditRead: AuditReadService) {}

  @Get()
  list(
    @Query('actorUserId') actorUserId?: string,
    @Query('action') action?: string,
    @Query('entityType') entityType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.auditRead.list({ actorUserId, action, entityType, from, to });
  }
}
