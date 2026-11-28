import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { MAX_SECTIONS } from '../../learning/domain/learning';

export class ReadingPositionDto {
  @ApiProperty({ description: 'Índice (desde 0) de la última sección alcanzada en `secciones`.', minimum: 0, maximum: MAX_SECTIONS - 1 })
  @IsInt() @Min(0) @Max(MAX_SECTIONS - 1) puntoActual!: number;
}
