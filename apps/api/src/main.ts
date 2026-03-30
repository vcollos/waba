import 'reflect-metadata';
import helmet from 'helmet';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { getEnv } from './common/env';

async function bootstrap() {
  const env = getEnv();
  if (env.metaAllowInsecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    Logger.warn(
      'META_ALLOW_INSECURE_TLS enabled; outbound HTTPS certificate validation is disabled.',
      'Bootstrap',
    );
  }
  const app = await NestFactory.create(AppModule, {
    cors: {
      origin: env.corsOrigin.split(',').map((origin) => origin.trim()),
      credentials: true,
    },
  });

  app.use(helmet());
  app.setGlobalPrefix('api');

  await app.listen(env.port);
}

void bootstrap();
