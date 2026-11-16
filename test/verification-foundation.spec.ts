import { randomBytes } from 'node:crypto';
import { ValidationPipe } from '@nestjs/common';
import { Types } from 'mongoose';
import { RegisterDto } from '../src/modules/identity/presentation/dto/register.dto';
import { VerifyEmailDto } from '../src/modules/identity/presentation/dto/verify-email.dto';
import { VerificationCodeService } from '../src/modules/identity/infrastructure/verification-code.service';
import { TestVerificationMailer } from '../src/modules/identity/infrastructure/test-verification-mailer';
import { environmentSchema } from '../src/config/environment';
import { ConfigService } from '@nestjs/config';
import { verificationCodesFromConfig, verificationPolicyFromConfig } from '../src/modules/identity/application/verification-policy';

describe('Preparación de verificación', () => {
  it('normaliza la entrada y rechaza roles y propiedades adicionales', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const metadata = { type: 'body' as const, metatype: RegisterDto };
    const dto = await pipe.transform({ nombre: 'Ejemplo', correo: '  TEST@EXAMPLE.INVALID ', contraseña: 'ejemplo' }, metadata) as RegisterDto;
    expect(dto.correo).toBe('test@example.invalid');
    await expect(pipe.transform({ nombre: 'Ejemplo', correo: 'test@example.invalid', contraseña: 'ejemplo', rol: 'otro' }, metadata)).rejects.toThrow();
    await expect(pipe.transform({ correo: 'test@example.invalid', codigo: '12345x' }, { type: 'body', metatype: VerifyEmailDto })).rejects.toThrow();
  });

  it('genera códigos de seis cifras y los protege por usuario y propósito con HMAC', () => {
    const key = randomBytes(32);
    const service = new VerificationCodeService(key, randomBytes(32));
    const user = new Types.ObjectId();
    const token = new Types.ObjectId();
    const code = service.generate();
    expect(code).toMatch(/^\d{6}$/);
    const hash = service.digest(user, token, code);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(service.verify(user, token, code, hash)).toBe(true);
    expect(service.verify(new Types.ObjectId(), token, code, hash)).toBe(false);
    expect(service.verify(user, new Types.ObjectId(), code, hash)).toBe(false);
    expect(service.verify(user, token, code === '000000' ? '000001' : '000000', hash)).toBe(false);
    expect(service.verify(user, token, code, 'malformado')).toBe(false);
    expect(() => new VerificationCodeService(key, key)).toThrow();
    expect(() => new VerificationCodeService(Buffer.alloc(32), randomBytes(32))).toThrow();
  });

  it('usa un buzón exclusivamente de pruebas, sin transporte externo', async () => {
    const mailer = new TestVerificationMailer();
    await mailer.sendVerification('test@example.invalid', '123456');
    expect(mailer.takeMessages()).toEqual([{ recipient: 'test@example.invalid', code: '123456' }]);
    expect(mailer.takeMessages()).toEqual([]);
  });
  it('valida la clave independiente y obtiene cuotas de configuración', () => {
    const jwt = randomBytes(32).toString('base64');
    const key = randomBytes(32).toString('base64');
    const settings = { MONGODB_URI: 'mongodb://localhost/test', JWT_ACCESS_SECRET_BASE64: jwt, JWT_ACCESS_ISSUER: 'test', JWT_ACCESS_AUDIENCE: 'test', JWT_ACCESS_TTL_SECONDS: 60, VERIFICATION_CODE_HMAC_KEY_BASE64: key, RATE_LIMIT_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), REDIS_URL: 'redis://:test-only@localhost:6380', VERIFICATION_ACCOUNT_FAILURES_PER_HOUR: 7, VERIFICATION_ACCOUNT_EMISSIONS_PER_HOUR: 3 };
    expect(environmentSchema.validate(settings).error).toBeUndefined();
    expect(environmentSchema.validate({ ...settings, VERIFICATION_CODE_HMAC_KEY_BASE64: jwt }).error).toBeDefined();
    const config = new ConfigService(settings);
    expect(verificationCodesFromConfig(config)).toBeInstanceOf(VerificationCodeService);
    expect(verificationPolicyFromConfig(config)).toEqual({ maxFailuresPerHour: 7, maxEmissionsPerHour: 3 });
  });
});
