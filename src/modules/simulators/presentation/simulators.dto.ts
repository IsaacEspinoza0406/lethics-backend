import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsMongoId, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { MAX_DECISION_LENGTH } from '../domain/simulator';

export class SimulatorParams {
  @ApiProperty({ description: 'ObjectId del simulador.' })
  @IsMongoId() simuladorId!: string;
}
export class SimulatorAnswerDto {
  @ApiProperty({ description: 'Versión del caso que se respondió, tal como se recibió.', minimum: 1 })
  @IsInt() @Min(1) @Max(2147483647) version!: number;
  @ApiProperty({ description: 'Respuesta del estudiante en texto libre.', maxLength: MAX_DECISION_LENGTH })
  @IsString() @Matches(/\S/) @MaxLength(MAX_DECISION_LENGTH) decision!: string;
}
