import { HttpException, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { OriginQuotaExceededError } from '../identity/application/identity-operations.service';

export function authHttpFailure(error: unknown): HttpException {
  if (error instanceof OriginQuotaExceededError) return new HttpException('Límite de solicitudes alcanzado', HttpStatus.TOO_MANY_REQUESTS);
  return new ServiceUnavailableException();
}
