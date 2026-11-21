import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { createTransport } from 'nodemailer';
import { environmentSchema } from '../src/config/environment';
import { SmtpVerificationMailer } from '../src/modules/identity/infrastructure/smtp-verification-mailer';
import { verificationMailerFromConfig } from '../src/modules/identity/infrastructure/verification-mailer.factory';
import { TestVerificationMailer } from '../src/modules/identity/infrastructure/test-verification-mailer';
import { VerificationDeliveryError } from '../src/modules/identity/application/verification-mailer';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

describe('SMTP desacoplado y exclusivamente simulado durante pruebas', () => {
  const smtp = { NODE_ENV: 'development', VERIFICATION_MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.invalid', SMTP_PORT: 465, SMTP_SECURE: true, SMTP_USER: 'test-only', SMTP_PASSWORD: 'test-only-password', SMTP_FROM: 'verification@example.invalid' };
  const transport = { verify: jest.fn(), sendMail: jest.fn(), close: jest.fn() };
  beforeEach(() => {
    jest.clearAllMocks(); (createTransport as jest.Mock).mockReturnValue(transport);
    transport.verify.mockResolvedValue(true);
    transport.sendMail.mockResolvedValue({ accepted: ['persona@example.invalid'], rejected: [] });
  });
  it('configura TLS validado, sin logs, archivos, URLs ni pool', async () => {
    const mailer = new SmtpVerificationMailer(new ConfigService(smtp));
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: true, logger: false, debug: false, pool: false, disableFileAccess: true, disableUrlAccess: true, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' } }));
    await mailer.sendVerification('persona@example.invalid', '012345');
    expect(transport.sendMail).toHaveBeenCalledWith({ from: smtp.SMTP_FROM, to: 'persona@example.invalid', subject: expect.any(String), text: expect.stringContaining('012345') });
    mailer.onApplicationShutdown(); expect(transport.close).toHaveBeenCalledTimes(1);
  });
  it('exige STARTTLS cuando no usa TLS implícito', () => {
    new SmtpVerificationMailer(new ConfigService({ ...smtp, SMTP_PORT: 587, SMTP_SECURE: false }));
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: false, requireTLS: true }));
  });
  it('comprueba disponibilidad sin enviar y falla cerrado si la comprobación es incierta', async () => {
    const mailer = new SmtpVerificationMailer(new ConfigService(smtp));
    await mailer.assertAvailable();
    expect(transport.sendMail).not.toHaveBeenCalled();
    transport.verify.mockResolvedValueOnce(false);
    await expect(mailer.assertAvailable()).rejects.toBeInstanceOf(VerificationDeliveryError);
    transport.verify.mockRejectedValueOnce(new Error('private-secret'));
    await expect(mailer.assertAvailable()).rejects.not.toThrow('private-secret');
  });
  it.each([{ accepted: [], rejected: ['persona@example.invalid'] }, { accepted: [], rejected: [] }])('no afirma aceptación SMTP en respuesta %j', async (result) => {
    transport.sendMail.mockResolvedValueOnce(result);
    await expect(new SmtpVerificationMailer(new ConfigService(smtp)).sendVerification('persona@example.invalid', '012345')).rejects.toBeInstanceOf(VerificationDeliveryError);
  });
  it('sanitiza errores SMTP que contengan información sensible', async () => {
    transport.sendMail.mockRejectedValueOnce(new Error('private-password smtp-host codigo=012345'));
    const promise = new SmtpVerificationMailer(new ConfigService(smtp)).sendVerification('persona@example.invalid', '012345');
    await expect(promise).rejects.toThrow('No se pudo procesar el envío');
    await expect(promise).rejects.not.toThrow(/private-password|smtp-host|012345/);
  });
  it('rechaza inyección de cabeceras y códigos inválidos antes de enviar', async () => {
    const mailer = new SmtpVerificationMailer(new ConfigService(smtp));
    await expect(mailer.sendVerification('persona@example.invalid\r\nBcc:otra@example.invalid', '012345')).rejects.toThrow();
    await expect(mailer.sendVerification('persona@example.invalid', '12345x')).rejects.toThrow();
    expect(transport.sendMail).not.toHaveBeenCalled();
  });
  it('test nunca construye transporte real aun con configuración SMTP heredada', () => {
    expect(verificationMailerFromConfig(new ConfigService({ ...smtp, NODE_ENV: 'test' }))).toBeInstanceOf(TestVerificationMailer);
    expect(createTransport).not.toHaveBeenCalled();
  });
  it('desarrollo sin transporte rechaza entrega y producción sin SMTP conserva bloqueo de inicio', async () => {
    const disabled = verificationMailerFromConfig(new ConfigService({ NODE_ENV: 'development' }));
    await expect(disabled.sendVerification('persona@example.invalid', '012345')).rejects.toThrow('no configurado');
    expect(() => verificationMailerFromConfig(new ConfigService({ NODE_ENV: 'production' }))).toThrow('no configurado');
    expect(createTransport).not.toHaveBeenCalled();
  });
  it('la configuración HTTP exige activación y los parámetros SMTP completos', () => {
    const base = { MONGODB_URI: 'mongodb://localhost/test', JWT_ACCESS_SECRET_BASE64: randomBytes(32).toString('base64'), JWT_ACCESS_ISSUER: 'test', JWT_ACCESS_AUDIENCE: 'test', JWT_ACCESS_TTL_SECONDS: 900, VERIFICATION_CODE_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), RATE_LIMIT_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), REDIS_URL: 'redis://:test-only@localhost:6380' };
    const defaults = environmentSchema.validate(base);
    expect(defaults.error).toBeUndefined(); expect(defaults.value.AUTH_HTTP_ENABLED).toBe(false); expect(defaults.value.VERIFICATION_MAIL_TRANSPORT).toBe('disabled');
    expect(environmentSchema.validate({ ...base, VERIFICATION_MAIL_TRANSPORT: 'smtp' }).error).toBeDefined();
    expect(environmentSchema.validate({ ...base, ...smtp, AUTH_HTTP_ENABLED: 'true' }).error).toBeUndefined();
    for (const field of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM']) {
      const settings: Record<string, unknown> = { ...base, ...smtp }; delete settings[field];
      expect(environmentSchema.validate(settings).error).toBeDefined();
    }
    expect(environmentSchema.validate({ ...base, ...smtp, SMTP_FROM: 'bad\r\nFrom:another@example.invalid' }).error).toBeDefined();
  });
});
