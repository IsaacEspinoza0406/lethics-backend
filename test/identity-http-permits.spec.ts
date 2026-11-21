import { IdentityOperationsService } from '../src/modules/identity/application/identity-operations.service';
import { OriginRateLimitService, RateLimitUnavailableError } from '../src/infrastructure/rate-limit/origin-rate-limit.service';
import { RegistrationService } from '../src/modules/identity/application/registration.service';
import { VerifyEmailService } from '../src/modules/identity/application/verify-email.service';
import { ResendVerificationService } from '../src/modules/identity/application/resend-verification.service';

describe('Autorizaciones internas por origen de un solo uso', () => {
  function setup() {
    const limiter = { consume: jest.fn().mockResolvedValue({ allowed: true }) };
    const register = { register: jest.fn() }, verify = { verify: jest.fn().mockResolvedValue(true) }, resend = { resend: jest.fn() };
    const service = new IdentityOperationsService(limiter as unknown as OriginRateLimitService, register as unknown as RegistrationService, verify as unknown as VerifyEmailService, resend as unknown as ResendVerificationService);
    return { service, limiter, register, verify, resend };
  }
  it('aplica una sola cuota y no permite reutilizar ni falsificar el permiso', async () => {
    const { service, limiter, verify } = setup();
    const permit = await service.authorize('verify', '192.0.2.1', false);
    expect(await service.verify('192.0.2.1', false, 'persona@example.invalid', '012345', permit)).toBe(true);
    expect(limiter.consume).toHaveBeenCalledTimes(1);
    await expect(service.verify('192.0.2.1', false, 'persona@example.invalid', '012345', permit)).rejects.toBeInstanceOf(RateLimitUnavailableError);
    await expect(service.verify('192.0.2.1', false, 'persona@example.invalid', '012345', {})).rejects.toBeInstanceOf(RateLimitUnavailableError);
    expect(verify.verify).toHaveBeenCalledTimes(1);
  });
  it('vincula el permiso a operación, origen, modo de proxy e instancia emisora', async () => {
    const { service, resend } = setup();
    const permit = await service.authorize('verify', '192.0.2.1', false);
    await expect(service.resend('192.0.2.1', false, 'persona@example.invalid', permit)).rejects.toThrow();
    const otherOrigin = await service.authorize('verify', '192.0.2.1', false);
    await expect(service.verify('192.0.2.2', false, 'persona@example.invalid', '012345', otherOrigin)).rejects.toThrow();
    const otherMode = await service.authorize('verify', '192.0.2.1', false);
    await expect(service.verify('192.0.2.1', true, 'persona@example.invalid', '012345', otherMode)).rejects.toThrow();
    const otherService = setup().service;
    const otherInstance = await service.authorize('verify', '192.0.2.1', false);
    await expect(otherService.verify('192.0.2.1', false, 'persona@example.invalid', '012345', otherInstance)).rejects.toThrow();
    expect(resend.resend).not.toHaveBeenCalled();
  });
});
