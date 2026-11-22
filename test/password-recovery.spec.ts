import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ForgotPasswordDto, ResetPasswordDto } from '../src/modules/identity/presentation/dto/password-recovery.dto';
import { OpaqueTokenService } from '../src/infrastructure/security/opaque-token.service';
import { DevelopmentVerificationMailer } from '../src/modules/identity/infrastructure/development-verification-mailer';
import { TestVerificationMailer } from '../src/modules/identity/infrastructure/test-verification-mailer';

describe('Contratos de recuperación y separación de propósito', () => {
  const opaque = new OpaqueTokenService();
  it('normaliza correo con la regla existente y rechaza extras', async () => {
    const input = plainToInstance(ForgotPasswordDto, { correo: ' STUDENT@EXAMPLE.TEST ' });
    expect(input.correo).toBe('student@example.test'); expect(await validate(input)).toHaveLength(0);
    expect(await validate(plainToInstance(ForgotPasswordDto, { correo: 'student@example.test', rol: 'estudiante' }), { whitelist: true, forbidNonWhitelisted: true })).not.toHaveLength(0);
  });
  it('valida token opaco y misma política de contraseña que registro', async () => {
    const token = opaque.generate();
    expect(await validate(plainToInstance(ResetPasswordDto, { token, nuevaContraseña: 'synthetic-password' }))).toHaveLength(0);
    for (const value of [{ token: '123456', nuevaContraseña: 'valid' }, { token, nuevaContraseña: '' }, { token, nuevaContraseña: 1 }, { token, nuevaContraseña: 'x'.repeat(1025) }]) expect(await validate(plainToInstance(ResetPasswordDto, value))).not.toHaveLength(0);
  });
  it('separa hashes de recuperación, verificación opaca y refresh', () => {
    const token = opaque.generate(), hash = opaque.digest('password-reset', token);
    expect(hash).not.toBe(opaque.digest('account', token)); expect(hash).not.toBe(opaque.digest('refresh', token));
    expect(opaque.verify('password-reset', token, hash)).toBe(true); expect(opaque.verify('refresh', token, hash)).toBe(false);
  });
  it('adaptadores de desarrollo/test no envían ni registran secretos', async () => {
    await expect(new DevelopmentVerificationMailer().sendPasswordRecovery()).rejects.toThrow('Transporte de correo no configurado');
    const mailer = new TestVerificationMailer(), token = opaque.generate();
    await mailer.sendPasswordRecovery('student@example.test', token, 15);
    expect(mailer.takeRecoveryMessages()).toEqual([{ recipient: 'student@example.test', token, expiresInMinutes: 15 }]);
    expect(mailer.takeRecoveryMessages()).toEqual([]); expect(mailer.takeMessages()).toEqual([]);
  });
});
