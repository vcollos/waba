import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Corpo de criação de lista `POST /api/public/v1/lists`. */
export class CreateListDto {
  @ApiPropertyOptional({
    description: 'Nome da lista. Default: "Lista via API".',
    example: 'Assinantes de contrato',
  })
  name?: string;

  @ApiPropertyOptional({
    description: 'Descrição livre da lista.',
    example: 'Contatos que assinaram o contrato em julho',
  })
  description?: string;
}

/** Item de contato na ingestão em lote. */
export class IngestContactDto {
  @ApiPropertyOptional({
    description: 'Nome completo (usado quando firstName/lastName não são enviados).',
    example: 'Maria Silva',
  })
  name?: string;

  @ApiPropertyOptional({ description: 'Primeiro nome.', example: 'Maria' })
  firstName?: string;

  @ApiPropertyOptional({ description: 'Sobrenome.', example: 'Silva' })
  lastName?: string;

  @ApiProperty({
    description: 'Telefone em E.164 (com DDI). Contatos inválidos são contados como "invalid".',
    example: '+5519998887766',
  })
  phone!: string;

  @ApiPropertyOptional({
    description: 'E-mail do contato.',
    example: 'maria@cliente.com',
    nullable: true,
  })
  email?: string | null;

  @ApiPropertyOptional({
    description: 'Categoria/segmento livre do contato.',
    example: 'assinante',
    nullable: true,
  })
  category?: string | null;
}

/** Corpo da ingestão `POST /api/public/v1/lists/:id/contacts`. */
export class IngestContactsDto {
  @ApiProperty({
    description: 'Lote de contatos (máximo 5000 por requisição).',
    type: [IngestContactDto],
  })
  contacts!: IngestContactDto[];
}

/** Resultado da ingestão de contatos. */
export class IngestContactsResponseDto {
  @ApiProperty({ description: 'ID da lista de destino.', example: 'lst_01H...' })
  listId!: string;

  @ApiProperty({ description: 'Total de itens recebidos no corpo.', example: 100 })
  received!: number;

  @ApiProperty({ description: 'Contatos novos inseridos.', example: 80 })
  inserted!: number;

  @ApiProperty({ description: 'Contatos existentes atualizados.', example: 15 })
  updated!: number;

  @ApiProperty({ description: 'Itens ignorados (já presentes/sem mudança).', example: 3 })
  skipped!: number;

  @ApiProperty({ description: 'Itens inválidos (telefone incorreto etc.).', example: 2 })
  invalid!: number;
}
