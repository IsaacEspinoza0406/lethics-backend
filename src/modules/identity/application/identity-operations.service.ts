import { LimitedOperation, OriginRateLimitService, RateLimitUnavailableError } from '../../../infrastructure/rate-limit/origin-rate-limit.service';
import { RegistrationService } from './registration.service';
import { ResendVerificationService } from './resend-verification.service';
import { VerifyEmailService } from './verify-email.service';

export class OriginQuotaExceededError extends Error { constructor() { super('Límite de solicitudes alcanzado'); } }

/** Internal boundary; origin and proxy mode must come from trusted server configuration. */
export class IdentityOperationsService {
  private readonly permits = new WeakMap<object, { operation: LimitedOperation; origin: string | undefined; behindProxy: boolean }>();
  constructor(private readonly limiter: OriginRateLimitService, private readonly registration: RegistrationService, private readonly verification: VerifyEmailService, private readonly resendService: ResendVerificationService) {}

  private async allow(operation: LimitedOperation, origin: string | undefined, behindProxy: boolean, permit?: object): Promise<void> {
    if (permit) {
      const issued = this.permits.get(permit);
      this.permits.delete(permit);
      if (!issued || issued.operation !== operation || issued.origin !== origin || issued.behindProxy !== behindProxy) throw new RateLimitUnavailableError();
      return;
    }
    if (!(await this.limiter.consume(operation, origin, behindProxy)).allowed) throw new OriginQuotaExceededError();
  }
  /** HTTP guard consumes quota before DTO/index work. The opaque permit is server-only and single-use. */
  async authorize(operation: LimitedOperation, origin: string | undefined, behindProxy: boolean): Promise<object> {
    await this.allow(operation, origin, behindProxy);
    const permit = Object.freeze({});
    this.permits.set(permit, { operation, origin, behindProxy });
    return permit;
  }
  async register(origin: string | undefined, behindProxy: boolean, input: { nombre: string; correo: string; contraseña: string }, permit?: object): Promise<void> {
    await this.allow('register', origin, behindProxy, permit);
    await this.registration.register(input);
  }
  async verify(origin: string | undefined, behindProxy: boolean, correo: string, codigo: string, permit?: object): Promise<boolean> {
    await this.allow('verify', origin, behindProxy, permit);
    return this.verification.verify(correo, codigo);
  }
  async resend(origin: string | undefined, behindProxy: boolean, correo: string, permit?: object): Promise<void> {
    await this.allow('resend', origin, behindProxy, permit);
    await this.resendService.resend(correo);
  }
}
