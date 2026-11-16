import { OriginRateLimitService } from '../../../infrastructure/rate-limit/origin-rate-limit.service';
import { RegistrationService } from './registration.service';
import { ResendVerificationService } from './resend-verification.service';
import { VerifyEmailService } from './verify-email.service';

export class OriginQuotaExceededError extends Error { constructor() { super('Límite de solicitudes alcanzado'); } }

/** Internal boundary; origin and proxy mode must come from trusted server configuration. */
export class IdentityOperationsService {
  constructor(private readonly limiter: OriginRateLimitService, private readonly registration: RegistrationService, private readonly verification: VerifyEmailService, private readonly resendService: ResendVerificationService) {}

  private async allow(operation: 'register' | 'verify' | 'resend', origin: string | undefined, behindProxy: boolean): Promise<void> {
    if (!(await this.limiter.consume(operation, origin, behindProxy)).allowed) throw new OriginQuotaExceededError();
  }
  async register(origin: string | undefined, behindProxy: boolean, input: { nombre: string; correo: string; contraseña: string }): Promise<void> {
    await this.allow('register', origin, behindProxy);
    await this.registration.register(input);
  }
  async verify(origin: string | undefined, behindProxy: boolean, correo: string, codigo: string): Promise<boolean> {
    await this.allow('verify', origin, behindProxy);
    return this.verification.verify(correo, codigo);
  }
  async resend(origin: string | undefined, behindProxy: boolean, correo: string): Promise<void> {
    await this.allow('resend', origin, behindProxy);
    await this.resendService.resend(correo);
  }
}
