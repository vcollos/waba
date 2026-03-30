import { Module } from '@nestjs/common';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { DispatchService } from './dispatch.service';
import { IntegrationsModule } from '../integrations/integrations.module';

@Module({
  imports: [IntegrationsModule],
  controllers: [CampaignsController],
  providers: [CampaignsService, DispatchService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
