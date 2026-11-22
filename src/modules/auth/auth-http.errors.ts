import { HttpException, HttpStatus, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { LoginDeniedError } from '../identity/application/login.service';
import { SessionDeniedError } from '../identity/application/session.service';
import { PasswordResetDeniedError } from '../identity/application/password-recovery.service';
import { OriginQuotaExceededError } from '../identity/application/identity-operations.service';

export function authHttpFailure(error: unknown): HttpException {
  if (error instanceof PasswordResetDeniedError) return new HttpException('Solicitud de restablecimiento no válida.', HttpStatus.BAD_REQUEST);
  if (error instanceof OriginQuotaExceededError) return new HttpException('Límite de solicitudes alcanzado', HttpStatus.TOO_MANY_REQUESTS);
  if (error instanceof LoginDeniedError) return new UnauthorizedException('Credenciales no válidas.');
  if (error instanceof SessionDeniedError) return new UnauthorizedException('Sesión no válida.');
  return new ServiceUnavailableException();
}
