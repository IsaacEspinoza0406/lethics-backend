import { IsMongoId } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class DeckParams {
  @ApiProperty({ description: 'ObjectId del módulo cuyo mazo se consulta.' })
  @IsMongoId() moduloId!: string;
}
