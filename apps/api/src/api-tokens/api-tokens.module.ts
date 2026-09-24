import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { TransactionalModule } from '../transactional/transactional.module';
import { ApiTokenGuard } from './api-token.guard';
import { ApiTokensController } from './api-tokens.controller';
import { ApiTokensService } from './api-tokens.service';
import { PublicApiController } from './public-api.controller';
import { PublicCampaignsService } from './public-campaigns.service';
import { PublicFollowupsService } from './public-followups.service';

@Module({
  imports: [ContactsModule, TransactionalModule, CampaignsModule],
  controllers: [ApiTokensController, PublicApiController],
  providers: [ApiTokensService, ApiTokenGuard, PublicCampaignsService, PublicFollowupsService],
  exports: [ApiTokensService],
})
export class ApiTokensModule {}
