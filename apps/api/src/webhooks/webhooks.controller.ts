import { Body, Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { Public } from '../common/auth';
import { IntegrationsService } from '../integrations/integrations.service';
import { WebhookSignatureGuard } from './webhook-signature.guard';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks/meta/whatsapp')
export class WebhooksController {
  constructor(
    private readonly webhooksService: WebhooksService,
    private readonly integrationsService: IntegrationsService,
  ) {}

  @Public()
  @Get()
  async verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') verifyToken: string,
    @Query('hub.challenge') challenge: string,
    @Res() response: Response,
  ) {
    const match = await this.integrationsService.hasVerifyToken(verifyToken);
    if (mode === 'subscribe' && match) {
      return response.status(200).send(challenge);
    }

    return response.sendStatus(403);
  }

  // @Public() dispensa o JWT; a autenticidade vem da assinatura HMAC da Meta,
  // verificada pelo WebhookSignatureGuard ANTES de qualquer processamento.
  @Public()
  @UseGuards(WebhookSignatureGuard)
  @Post()
  process(@Body() payload: Record<string, unknown>) {
    return this.webhooksService.process(payload);
  }
}
