import { IdentityOperationsService, OriginQuotaExceededError } from '../src/modules/identity/application/identity-operations.service';
import { OriginRateLimitService, RateLimitUnavailableError } from '../src/infrastructure/rate-limit/origin-rate-limit.service';
import { RegistrationService } from '../src/modules/identity/application/registration.service';
import { VerifyEmailService } from '../src/modules/identity/application/verify-email.service';
import { ResendVerificationService } from '../src/modules/identity/application/resend-verification.service';

it('aplica el limitador antes de cualquier operación y falla cerrado', async () => {
  const limiter = { consume: jest.fn().mockRejectedValueOnce(new RateLimitUnavailableError()).mockResolvedValueOnce({ allowed: false }).mockResolvedValueOnce({ allowed: true }) };
  const register = { register: jest.fn() };
  const verify = { verify: jest.fn().mockResolvedValue(true) };
  const resend = { resend: jest.fn() };
  const service = new IdentityOperationsService(limiter as unknown as OriginRateLimitService, register as unknown as RegistrationService, verify as unknown as VerifyEmailService, resend as unknown as ResendVerificationService);
  await expect(service.register('127.0.0.1', false, { nombre: 'x', correo: 'test@example.invalid', contraseña: 'x' })).rejects.toBeInstanceOf(RateLimitUnavailableError);
  await expect(service.resend('127.0.0.1', false, 'test@example.invalid')).rejects.toBeInstanceOf(OriginQuotaExceededError);
  expect(register.register).not.toHaveBeenCalled();
  expect(resend.resend).not.toHaveBeenCalled();
  expect(await service.verify('127.0.0.1', false, 'test@example.invalid', '123456')).toBe(true);
  expect(verify.verify).toHaveBeenCalledTimes(1);
});
