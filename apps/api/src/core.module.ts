import { Global, Module } from '@nestjs/common';
import { AuditService } from './common/audit.service';
import { CryptoService } from './common/crypto.service';
import { DatabaseService } from './database/database.service';

@Global()
@Module({
  providers: [DatabaseService, CryptoService, AuditService],
  exports: [DatabaseService, CryptoService, AuditService],
})
export class CoreModule {}
