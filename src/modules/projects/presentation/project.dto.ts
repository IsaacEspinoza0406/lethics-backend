import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EVIDENCE_BOUND } from '../domain/project';

export class ProjectCourseParams { @ApiProperty() @IsMongoId() cursoId!: string }
export class ProjectSubmissionParams { @ApiProperty() @IsMongoId() entregaId!: string }
export class ProjectEvidenceDto {
  @ApiProperty({ enum: ['enlace', 'archivo'] }) @IsIn(['enlace', 'archivo']) tipo!: 'enlace' | 'archivo';
  @ApiPropertyOptional({ description: 'HTTPS; solo para tipo enlace.' }) @IsOptional() @IsString() @MaxLength(2048) url?: string;
  @ApiPropertyOptional({ description: 'Identificador opaco del almacenamiento confiable; no URL ni ruta.' }) @IsOptional() @IsString() @Matches(/^[a-zA-Z\d_-]{1,128}$/) referencia?: string;
}
export class SubmitProjectDto {
  @ApiProperty({ description: 'Reutilizar solo para repetir exactamente la misma petición.' }) @IsString() @Matches(/\S/) @MaxLength(128) solicitudId!: string;
  @ApiProperty({ type: [ProjectEvidenceDto], minItems: 1, maxItems: EVIDENCE_BOUND })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(EVIDENCE_BOUND) @ValidateNested({ each: true }) @Type(() => ProjectEvidenceDto)
  evidencias!: ProjectEvidenceDto[];
}
export class ProjectHistoryDto {
  @ApiPropertyOptional({ default: 1, maximum: 10000 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) pagina = 1;
  @ApiPropertyOptional({ default: 20, maximum: 50 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limite = 20;
}
