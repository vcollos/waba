import { Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { AppBootstrapService } from './app-bootstrap.service';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './common/auth.guard';
import { CampaignsModule } from './campaigns/campaigns.module';
import { ClientsModule } from './clients/clients.module';
import { ContactsModule } from './contacts/contacts.module';
import { CoreModule } from './core.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { LibraryModule } from './library/library.module';
import { ResultsModule } from './results/results.module';
import { UsersModule } from './users/users.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    CoreModule,
    AuditModule,
    AuthModule,
    CampaignsModule,
    ClientsModule,
    ContactsModule,
    DashboardModule,
    IntegrationsModule,
    LibraryModule,
    ResultsModule,
    UsersModule,
    WebhooksModule,
  ],
  providers: [
    AppBootstrapService,
    {
      provide: APP_GUARD,
      inject: [Reflector],
      useFactory: (reflector: Reflector) => new JwtAuthGuard(reflector),
    },
  ],
})
export class AppModule {}
