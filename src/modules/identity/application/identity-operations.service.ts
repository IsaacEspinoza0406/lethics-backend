import { LimitedOperation, OriginRateLimitService, RateLimitUnavailableError } from '../../../infrastructure/rate-limit/origin-rate-limit.service';
import { RegistrationService } from './registration.service';
import { ResendVerificationService } from './resend-verification.service';
import { LoginService, LoginResult } from './login.service';
import { VerifyEmailService } from './verify-email.service';
import { SessionService } from './session.service';

export class OriginQuotaExceededError extends Error { constructor() { super('Límite de solicitudes alcanzado'); } }

/** Internal boundary; origin and proxy mode must come from trusted server configuration. */
export class IdentityOperationsService {
  private readonly permits = new WeakMap<object, { operation: LimitedOperation; origin: string | undefined; behindProxy: boolean }>();
  constructor(private readonly limiter: OriginRateLimitService, private readonly registration: RegistrationService, private readonly verification: VerifyEmailService, private readonly resendService: ResendVerificationService, private readonly loginService?: LoginService, private readonly sessionService?: SessionService) {}

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
  async login(origin: string | undefined, behindProxy: boolean, input: { correo: string; contraseña: string }, permit?: object): Promise<LoginResult> {
    await this.allow('login', origin, behindProxy, permit);
    if (!this.loginService) throw new Error('Login no disponible');
    return this.loginService.login(input);
  }
  async refresh(origin: string | undefined, behindProxy: boolean, token: string | undefined, permit?: object): Promise<LoginResult> {
    await this.allow('refresh', origin, behindProxy, permit);
    if (!this.sessionService) throw new Error('Sesiones no disponibles');
    return this.sessionService.refresh(token);
  }
  async logout(origin: string | undefined, behindProxy: boolean, token: string | undefined, permit?: object): Promise<void> {
    await this.allow('logout', origin, behindProxy, permit);
    if (!this.sessionService) throw new Error('Sesiones no disponibles');
    await this.sessionService.logout(token);
  }
}
