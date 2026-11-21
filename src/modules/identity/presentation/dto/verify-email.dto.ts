import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyEmailDto {
  @ApiProperty({ example: 'persona@example.invalid', maxLength: 254 })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail()
  @MaxLength(254)
  correo!: string;

  @ApiProperty({ example: '012345', pattern: '^[0-9]{6}$', minLength: 6, maxLength: 6 })
  @IsString()
  @Matches(/^[0-9]{6}$/)
  codigo!: string;
}
