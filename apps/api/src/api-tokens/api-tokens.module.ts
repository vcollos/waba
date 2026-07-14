import { Module } from '@nestjs/common';
import { ContactsModule } from '../contacts/contacts.module';
import { ApiTokenGuard } from './api-token.guard';
import { ApiTokensController } from './api-tokens.controller';
import { ApiTokensService } from './api-tokens.service';
import { PublicApiController } from './public-api.controller';

@Module({
  imports: [ContactsModule],
  controllers: [ApiTokensController, PublicApiController],
  providers: [ApiTokensService, ApiTokenGuard],
  exports: [ApiTokensService],
})
export class ApiTokensModule {}
