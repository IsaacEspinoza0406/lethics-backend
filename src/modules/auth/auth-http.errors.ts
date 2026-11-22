import { HttpException, HttpStatus, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { LoginDeniedError } from '../identity/application/login.service';
import { SessionDeniedError } from '../identity/application/session.service';
import { OriginQuotaExceededError } from '../identity/application/identity-operations.service';

export function authHttpFailure(error: unknown): HttpException {
  if (error instanceof OriginQuotaExceededError) return new HttpException('Límite de solicitudes alcanzado', HttpStatus.TOO_MANY_REQUESTS);
  if (error instanceof LoginDeniedError) return new UnauthorizedException('Credenciales no válidas.');
  if (error instanceof SessionDeniedError) return new UnauthorizedException('Sesión no válida.');
  return new ServiceUnavailableException();
}
