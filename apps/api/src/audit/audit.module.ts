import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditReadService } from './audit-read.service';

@Module({
  controllers: [AuditController],
  providers: [AuditReadService],
})
export class AuditModule {}
