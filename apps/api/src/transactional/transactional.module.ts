import { Module } from '@nestjs/common';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { TransactionalCallbackService } from './transactional-callback.service';
import { TransactionalRateLimiter } from './transactional.rate-limiter';
import { TransactionalService } from './transactional.service';

/**
 * Canal de disparo transacional (OTP / token / assinatura de venda) exposto pela
 * API pública. Reusa CampaignsService (summary/refresh) e MetaGraphService
 * (envio síncrono). Sem ciclo: Transactional -> Campaigns -> Integrations.
 */
@Module({
  imports: [CampaignsModule, IntegrationsModule],
  providers: [TransactionalService, TransactionalCallbackService, TransactionalRateLimiter],
  exports: [TransactionalService, TransactionalCallbackService, TransactionalRateLimiter],
})
export class TransactionalModule {}
