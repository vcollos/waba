import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Corpo do disparo transacional `POST /api/public/v1/messages`.
 * Documentação apenas — o controller mantém o body inline; o tenant vem sempre
 * do token (nunca do corpo).
 */
export class SendMessageDto {
  @ApiProperty({
    description: 'Destino no formato E.164 (com DDI). Ex.: Brasil +55.',
    example: '+5519998887766',
  })
  to!: string;

  @ApiProperty({
    description:
      'Nome do template aprovado (UTILITY ou AUTHENTICATION). MARKETING é bloqueado neste canal.',
    example: 'confirmacao_assinatura_contrato',
  })
  template!: string;

  @ApiPropertyOptional({
    description:
      'Idioma do template (código Meta). Opcional quando o template existe em um único idioma.',
    example: 'pt_BR',
  })
  language?: string;

  @ApiPropertyOptional({
    description:
      'Variáveis do template por índice posicional ({{1}}, {{2}}...). Para OTP/token use { "1": "123456" }.',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { '1': '123456' },
  })
  variables?: Record<string, string>;

  @ApiPropertyOptional({
    description:
      'ID da integração WABA do tenant. Obrigatório apenas quando o tenant tem mais de uma integração ativa.',
    example: 'int_01H...',
  })
  integrationId?: string;

  @ApiPropertyOptional({
    description:
      'URL HTTPS pública para receber callbacks de status (sent/delivered/read/failed). Validada contra SSRF.',
    example: 'https://sistema.cliente/waba/status',
  })
  callbackUrl?: string;
}

/** Resposta do disparo aceito. */
export class SendMessageResponseDto {
  @ApiProperty({
    description: 'ID interno da mensagem no WABA (use para reconciliar callbacks).',
    example: 'msg_01H...',
  })
  id!: string;

  @ApiProperty({
    description: 'ID da mensagem na Meta (wamid), quando disponível.',
    example: 'wamid.HBgMNTUxOTk...',
    nullable: true,
  })
  providerMessageId!: string | null;

  @ApiProperty({
    description: 'Status inicial do disparo (sempre "accepted" no envio síncrono).',
    example: 'accepted',
  })
  status!: string;

  @ApiProperty({
    description: 'Destino normalizado em E.164.',
    example: '+5519998887766',
  })
  to!: string;

  @ApiPropertyOptional({
    description:
      'Segredo do callback exibido UMA única vez (só quando callbackUrl foi informado). Guarde para validar a assinatura X-Waba-Signature.',
    example: 'whsec_...',
  })
  callbackSecret?: string;
}
