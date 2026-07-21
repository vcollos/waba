import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { TransactionalModule } from '../transactional/transactional.module';
import { ApiTokenGuard } from './api-token.guard';
import { ApiTokensController } from './api-tokens.controller';
import { ApiTokensService } from './api-tokens.service';
import { PublicApiController } from './public-api.controller';

@Module({
  imports: [ContactsModule, TransactionalModule],
  controllers: [ApiTokensController, PublicApiController],
  providers: [ApiTokensService, ApiTokenGuard],
  exports: [ApiTokensService],
})
export class ApiTokensModule {}
