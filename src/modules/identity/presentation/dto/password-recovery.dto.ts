import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { ResendVerificationDto } from './resend-verification.dto';

export class ForgotPasswordDto extends ResendVerificationDto {}
export class ResetPasswordDto {
  @ApiProperty({ description: 'Credencial opaca recibida por correo; no incluir en URL ni logs.', writeOnly: true, minLength: 43, maxLength: 43 })
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/)
  token!: string;

  @ApiProperty({ description: 'Nueva contraseña, con la misma política de registro.', writeOnly: true, maxLength: 1024 })
  @IsString() @IsNotEmpty() @MaxLength(1024)
  nuevaContraseña!: string;
}
