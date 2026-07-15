import { Module } from '@nestjs/common';
import { AdminTenantsController } from './admin-tenants.controller';
import { AdminTenantsService } from './admin-tenants.service';

@Module({
  controllers: [AdminTenantsController],
  providers: [AdminTenantsService],
})
export class AdminTenantsModule {}
