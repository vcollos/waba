import { Module } from '@nestjs/common';
import { WebhookSignatureGuard } from './webhook-signature.guard';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { IntegrationsModule } from '../integrations/integrations.module';

@Module({
  imports: [CampaignsModule, IntegrationsModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookSignatureGuard],
})
export class WebhooksModule {}
