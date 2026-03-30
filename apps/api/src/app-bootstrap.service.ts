import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { getEnv } from './common/env';
import { IntegrationsService } from './integrations/integrations.service';

@Injectable()
export class AppBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(AppBootstrapService.name);

  constructor(private readonly integrationsService: IntegrationsService) {}

  async onModuleInit(): Promise<void> {
    const env = getEnv();
    if (!env.metaIntegration) {
      return;
    }

    const integration = await this.integrationsService.upsertFromEnv(env.metaIntegration);
    this.logger.log(
      `Meta integration ready from .env: ${integration.name} (${integration.phoneNumberId})`,
    );
  }
}
