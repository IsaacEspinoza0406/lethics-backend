import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class EvaluationParams {
  @ApiProperty({ description: 'ObjectId de una versión de evaluación.' })
  @IsMongoId() evaluacionId!: string;
}
export class AttemptParams {
  @ApiProperty({ description: 'ObjectId del intento propio.' })
  @IsMongoId() intentoId!: string;
}
export class AnswerDto {
  @ApiProperty() @IsString() @Matches(/\S/) @MaxLength(128) preguntaId!: string;
  @ApiProperty() @IsString() @Matches(/\S/) @MaxLength(128) opcionId!: string;
}
export class SubmitAttemptDto {
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) @Max(2147483647) version!: number;
  @ApiProperty({ description: 'Identificador estable de la petición. Reutilizarlo solo para reintentar el mismo envío.', maxLength: 128 })
  @IsString() @Matches(/\S/) @MaxLength(128) solicitudId!: string;
  @ApiProperty({ type: [AnswerDto], minItems: 1, maxItems: 50 })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => AnswerDto)
  respuestas!: AnswerDto[];
}
export class PageDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 10000 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) pagina = 1;
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limite = 20;
}
export class EvaluationListDto extends PageDto {
  @ApiProperty() @IsMongoId() moduloId!: string;
}
export class HistoryDto extends PageDto {
  @ApiPropertyOptional() @IsOptional() @IsMongoId() evaluacionId?: string;
  @ApiPropertyOptional() @IsOptional() @IsMongoId() moduloId?: string;
  @ApiPropertyOptional({ enum: ['fecha_desc', 'fecha_asc', 'porcentaje_desc', 'porcentaje_asc'], default: 'fecha_desc' })
  @IsOptional() @IsIn(['fecha_desc', 'fecha_asc', 'porcentaje_desc', 'porcentaje_asc'])
  orden: 'fecha_desc' | 'fecha_asc' | 'porcentaje_desc' | 'porcentaje_asc' = 'fecha_desc';
}
