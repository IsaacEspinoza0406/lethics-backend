import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'Persona de ejemplo', maxLength: 200 })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  nombre!: string;

  @ApiProperty({ example: 'persona@example.invalid', maxLength: 254 })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail()
  @MaxLength(254)
  correo!: string;

  @ApiProperty({ example: 'contraseña-ficticia', writeOnly: true, maxLength: 1024 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  contraseña!: string;
}
