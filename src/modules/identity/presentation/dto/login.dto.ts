import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'estudiante@example.test', maxLength: 254 })
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsString() @IsEmail() @MaxLength(254)
  correo!: string;

  @ApiProperty({ writeOnly: true, maxLength: 1024, example: 'contraseña-ficticia' })
  @IsString() @IsNotEmpty() @MaxLength(1024)
  contraseña!: string;
}
