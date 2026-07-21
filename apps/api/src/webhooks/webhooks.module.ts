import { Module } from '@nestjs/common';
import { WebhookSignatureGuard } from './webhook-signature.guard';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { TransactionalModule } from '../transactional/transactional.module';

@Module({
  imports: [CampaignsModule, IntegrationsModule, TransactionalModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookSignatureGuard],
})
export class WebhooksModule {}
