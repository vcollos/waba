import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppBootstrapService } from './app-bootstrap.service';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './common/auth.guard';
import { CampaignsModule } from './campaigns/campaigns.module';
import { ContactsModule } from './contacts/contacts.module';
import { CoreModule } from './core.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { LibraryModule } from './library/library.module';
import { ResultsModule } from './results/results.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    CoreModule,
    AuthModule,
    CampaignsModule,
    ContactsModule,
    DashboardModule,
    IntegrationsModule,
    LibraryModule,
    ResultsModule,
    WebhooksModule,
  ],
  providers: [
    AppBootstrapService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
