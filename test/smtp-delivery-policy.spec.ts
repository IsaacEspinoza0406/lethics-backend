import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import { SmtpVerificationMailer } from '../src/modules/identity/infrastructure/smtp-verification-mailer';
import { classifySmtpFailure } from '../src/modules/identity/infrastructure/smtp-delivery-policy';
import { VerificationDeliveryError } from '../src/modules/identity/application/verification-mailer';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

describe('Reintentos SMTP conservadores dentro del proceso', () => {
  const config = new ConfigService({ SMTP_HOST: 'smtp.example.test', SMTP_PORT: 465, SMTP_SECURE: true,
    SMTP_USER: 'synthetic-user', SMTP_PASSWORD: 'synthetic-password', SMTP_FROM: 'verification@example.test' });
  const transport = { verify: jest.fn(), sendMail: jest.fn(), close: jest.fn() };
  beforeEach(() => {
    jest.useFakeTimers(); jest.clearAllMocks();
    (createTransport as jest.Mock).mockReturnValue(transport);
    transport.sendMail.mockReset().mockResolvedValue({ accepted: ['student@example.test'], rejected: [] });
  });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  const safe = [
    { code: 'ESOCKET', originalCode: 'ECONNREFUSED', command: 'CONN' },
    { code: 'EDNS', originalCode: 'EAI_AGAIN', command: 'CONN' },
    { code: 'ETIMEDOUT', timeoutType: 'CONNECT_TIMEOUT', command: 'CONN' },
    { code: 'ETIMEDOUT', timeoutType: 'GREETING_TIMEOUT', command: 'CONN' },
    { code: 'EENVELOPE', responseCode: 450, command: 'RCPT TO' },
    { code: 'EENVELOPE', responseCode: 451, command: 'MAIL FROM' },
    { code: 'ECONNECTION', responseCode: 421, command: 'EHLO' },
  ];
  it.each(safe)('reintenta una vez un fallo comprobablemente anterior al mensaje: %j', async (metadata) => {
    transport.sendMail.mockRejectedValueOnce(Object.assign(new Error('synthetic SMTP failure'), metadata));
    const mailer = new SmtpVerificationMailer(config);
    const pending = mailer.sendVerification('student@example.test', '012345');
    await jest.advanceTimersByTimeAsync(499);
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(transport.sendMail).toHaveBeenCalledTimes(2);
    expect(transport.sendMail.mock.calls[0][0]).toEqual(transport.sendMail.mock.calls[1][0]);
    expect(transport.sendMail.mock.calls[0][0].text).toContain('012345');
    expect(transport.sendMail.mock.calls[0][0].messageId).toMatch(/^<[^@]+@example\.test>$/);
    mailer.onApplicationShutdown();
  });

  const unsafe = [
    { code: 'ETIMEDOUT', timeoutType: 'SOCKET_TIMEOUT', command: 'CONN' },
    { code: 'ESOCKET', originalCode: 'ECONNRESET', command: 'CONN' },
    { code: 'ECONNECTION', command: 'CONN' },
    { code: 'ECONNECTION', responseCode: 421, command: 'CONN' },
    { code: 'ETIMEDOUT', command: 'DATA' },
    { code: 'ETIMEDOUT', command: 'CONN' },
    { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' },
    { code: 'EAUTH', responseCode: 454, command: 'AUTH PLAIN' },
    { code: 'ECONFIG' }, { code: 'ETLS' },
    { code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO' },
    { code: 'EENVELOPE', responseCode: 550, command: 'MAIL FROM' },
    { code: 'EMESSAGE', responseCode: 451, command: 'DATA' },
    { code: 'EENVELOPE', responseCode: 451, command: 'DATA' },
    { code: 'EDNS', originalCode: 'ENOTFOUND', command: 'CONN' },
    { code: 'EENVELOPE', responseCode: '451', command: 'RCPT TO' },
    {},
  ];
  it.each(unsafe)('no reintenta fallos permanentes, no demostrados o inciertos: %j', async (metadata) => {
    transport.sendMail.mockRejectedValue(Object.assign(new Error('private-server-text code=012345'), metadata));
    const mailer = new SmtpVerificationMailer(config);
    await expect(mailer.sendVerification('student@example.test', '012345')).rejects.toThrow('No se pudo procesar el envío');
    await jest.advanceTimersByTimeAsync(20_000);
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    mailer.onApplicationShutdown();
  });
  it('agota dos intentos sin declarar éxito ni dejar timers', async () => {
    transport.sendMail.mockRejectedValue(safe[0]);
    const mailer = new SmtpVerificationMailer(config);
    const pending = expect(mailer.sendVerification('student@example.test', '012345')).rejects.toBeInstanceOf(VerificationDeliveryError);
    await jest.advanceTimersByTimeAsync(20_000); await pending;
    expect(transport.sendMail).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
    mailer.onApplicationShutdown();
  });
  it('no programa reintento si la primera operación consumió la ventana de admisión', async () => {
    transport.sendMail.mockImplementationOnce(async () => { await new Promise((done) => setTimeout(done, 15_000)); throw safe[0]; });
    const mailer = new SmtpVerificationMailer(config);
    const pending = expect(mailer.sendVerification('student@example.test', '012345')).rejects.toBeInstanceOf(VerificationDeliveryError);
    await jest.advanceTimersByTimeAsync(20_000); await pending;
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    mailer.onApplicationShutdown();
  });
  it('no inicia otro intento si se solicita cierre durante el backoff', async () => {
    transport.sendMail.mockRejectedValueOnce(safe[0]);
    const mailer = new SmtpVerificationMailer(config);
    const pending = expect(mailer.sendVerification('student@example.test', '012345')).rejects.toBeInstanceOf(VerificationDeliveryError);
    await jest.advanceTimersByTimeAsync(1); mailer.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(500); await pending;
    expect(transport.sendMail).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
  });
  it('no reintenta una aceptación incompleta y genera otro Message-ID para otra invocación', async () => {
    const mailer = new SmtpVerificationMailer(config);
    transport.sendMail.mockResolvedValueOnce({ accepted: [], rejected: ['student@example.test'] });
    await expect(mailer.sendVerification('student@example.test', '012345')).rejects.toBeInstanceOf(VerificationDeliveryError);
    await mailer.sendVerification('student@example.test', '012345');
    expect(transport.sendMail).toHaveBeenCalledTimes(2);
    expect(transport.sendMail.mock.calls[0][0].messageId).not.toBe(transport.sendMail.mock.calls[1][0].messageId);
    mailer.onApplicationShutdown();
  });
  it('clasifica sin convertir el texto de error en una regla de reintento', () => {
    expect(classifySmtpFailure(new Error('ECONNREFUSED CONN retry'))).toEqual({ kind: 'uncertain', retryable: false });
    expect(classifySmtpFailure(null).retryable).toBe(false);
    expect(classifySmtpFailure(unsafe[6]).kind).toBe('authentication');
    expect(classifySmtpFailure(unsafe[8]).kind).toBe('configuration');
    expect(classifySmtpFailure(unsafe[10]).kind).toBe('recipient-rejected');
    expect(classifySmtpFailure(unsafe[12])).toEqual({ kind: 'temporary-rejection', retryable: false });
  });
});
