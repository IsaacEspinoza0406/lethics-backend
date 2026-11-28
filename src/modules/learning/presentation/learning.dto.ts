import { Type } from 'class-transformer';
import { IsInt, IsMongoId, IsOptional, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CourseParams {
  @ApiProperty({ description: 'ObjectId del curso.' })
  @IsMongoId() cursoId!: string;
}
export class ModuleParams {
  @ApiProperty({ description: 'ObjectId del módulo.' })
  @IsMongoId() moduloId!: string;
}
export class LessonParams {
  @ApiProperty({ description: 'ObjectId de la lección.' })
  @IsMongoId() leccionId!: string;
}
export class CourseListDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 10000 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) pagina = 1;
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limite = 20;
}
