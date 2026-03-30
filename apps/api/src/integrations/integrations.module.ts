import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { MetaGraphService } from './meta-graph.service';

@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService, MetaGraphService],
  exports: [IntegrationsService, MetaGraphService],
})
export class IntegrationsModule {}
