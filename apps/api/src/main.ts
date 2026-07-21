import 'reflect-metadata';
import helmet from 'helmet';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
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
    // rawBody preserva os BYTES CRUS do corpo em req.rawBody. Necessário para a
    // verificação HMAC do webhook da Meta (assinatura é sobre o buffer recebido,
    // não sobre o JSON reserializado). O body parser JSON padrão do Nest segue
    // ativo — nenhum bodyParser custom sobrescreve isto aqui.
    rawBody: true,
    cors: {
      origin: env.corsOrigin.split(',').map((origin) => origin.trim()),
      credentials: true,
    },
  });

  // helmet estrito (CSP default) para TODA a app — nenhum afrouxamento global.
  app.use(helmet());
  // Exceção só para o Swagger UI: a CSP default bloqueia os scripts/estilos
  // inline do swagger-ui. Registrado DEPOIS do helmet global e escopado ao path
  // `/api/docs` (cobre também os assets `/api/docs/*`), então vence e repõe o
  // header CSP relaxado apenas nessa rota. As demais rotas seguem a CSP estrita.
  app.use(
    '/api/docs',
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
        },
      },
    }),
  );
  app.setGlobalPrefix('api');

  // Swagger UI aberto (sem auth na página) documentando SOMENTE as rotas
  // públicas por token. As rotas administrativas (JWT) nunca são expostas.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Uniodonto WABA — API de Disparo')
    .setDescription(
      'API pública para disparo transacional (OTP/token, assinatura) e ingestão de contatos. ' +
        'Autenticação por token de API do tenant (Authorization: Bearer wba_...). Você só precisa do token.',
    )
    .setVersion('1.0')
    .addServer('https://waba-api.collos.com.br')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'wba_...' },
      'token',
    )
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  // Expõe SOMENTE as rotas públicas por token — nunca a API administrativa.
  document.paths = Object.fromEntries(
    Object.entries(document.paths).filter(([path]) => path.startsWith('/api/public/')),
  );
  SwaggerModule.setup('api/docs', app, document, {
    customSiteTitle: 'Uniodonto WABA — API',
    swaggerOptions: { persistAuthorization: true },
  });

  await app.listen(env.port);
}

void bootstrap();
