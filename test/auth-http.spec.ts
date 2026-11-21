import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import { createTransport } from 'nodemailer';
import request from 'supertest';
import { configureApp } from '../src/configure-app';
import { AuthController } from '../src/modules/auth/auth.controller';
import { AuthHttpGuard } from '../src/modules/auth/auth-http.guard';
import { AuthHttpPolicy } from '../src/modules/auth/auth-http.policy';
import { IdentityOperationsService } from '../src/modules/identity/application/identity-operations.service';
import { RegistrationService } from '../src/modules/identity/application/registration.service';
import { VerifyEmailService } from '../src/modules/identity/application/verify-email.service';
import { ResendVerificationService } from '../src/modules/identity/application/resend-verification.service';
import { VerificationDeliveryError, VerificationStateUnavailableError, VERIFICATION_MAILER } from '../src/modules/identity/application/verification-mailer';
import { SmtpVerificationMailer } from '../src/modules/identity/infrastructure/smtp-verification-mailer';
import { TestVerificationMailer } from '../src/modules/identity/infrastructure/test-verification-mailer';
import { OriginRateLimitService, RateLimitUnavailableError, resolveDirectOrigin } from '../src/infrastructure/rate-limit/origin-rate-limit.service';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

describe('Contratos HTTP de auth y protección operativa', () => {
  let app: INestApplication;
  const limiter = { consume: jest.fn() };
  const registration = { register: jest.fn() };
  const verification = { verify: jest.fn() };
  const resend = { resend: jest.fn() };
  const indexLists = jest.fn();
  const transport = { verify: jest.fn(), sendMail: jest.fn(), close: jest.fn() };
  async function setup(settings: { enabled?: boolean; proxy?: boolean; simulated?: boolean } = {}) {
    const config = new ConfigService({ AUTH_HTTP_ENABLED: settings.enabled ?? true, AUTH_BEHIND_PROXY: settings.proxy ?? false,
      SMTP_HOST: 'smtp.example.invalid', SMTP_PORT: 465, SMTP_SECURE: true, SMTP_USER: 'test-only', SMTP_PASSWORD: 'test-only', SMTP_FROM: 'verification@example.invalid' });
    (createTransport as jest.Mock).mockReturnValue(transport);
    const mailer = settings.simulated ? new TestVerificationMailer() : new SmtpVerificationMailer(config);
    const operations = new IdentityOperationsService(limiter as unknown as OriginRateLimitService, registration as unknown as RegistrationService, verification as unknown as VerifyEmailService, resend as unknown as ResendVerificationService);
    const module = await Test.createTestingModule({ controllers: [AuthController], providers: [AuthHttpGuard, AuthHttpPolicy,
      { provide: ConfigService, useValue: config }, { provide: VERIFICATION_MAILER, useValue: mailer },
      { provide: IdentityOperationsService, useValue: operations },
      { provide: getConnectionToken(), useValue: { readyState: 1, db: { collection: (name: string) => ({ listIndexes: () => ({ toArray: () => indexLists(name) }) }) } } },
    ] }).compile();
    app = module.createNestApplication(); configureApp(app); await app.init();
  }
  beforeEach(() => {
    jest.clearAllMocks();
    transport.verify.mockResolvedValue(true);
    limiter.consume.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    registration.register.mockResolvedValue(undefined); verification.verify.mockResolvedValue(true); resend.resend.mockResolvedValue(undefined);
    indexLists.mockImplementation(async (name: string) => name === 'usuarios' ? [{ name: 'correo_1', key: { correo: 1 }, unique: true }] : [{ name: 'tokenHash_1', key: { tokenHash: 1 }, unique: true }]);
  });
  afterEach(async () => { if (app) await app.close(); });
  const registerBody = { nombre: ' Persona ficticia ', correo: ' PERSONA@EXAMPLE.INVALID ', contraseña: 'ficticia' };
  const bodies = { register: registerBody, verify: { correo: registerBody.correo, codigo: '012345' }, resend: { correo: registerBody.correo } };

  it('registra con DTO normalizado sin serializar la entrada y consume una sola cuota del socket', async () => {
    await setup();
    const result = await request(app.getHttpServer()).post('/api/v1/auth/register').set('X-Forwarded-For', '192.0.2.99').set('Forwarded', 'for=203.0.113.9').send(registerBody).expect(202);
    expect(result.body).toEqual({ message: 'Solicitud recibida.' });
    expect(registration.register).toHaveBeenCalledWith({ nombre: 'Persona ficticia', correo: 'persona@example.invalid', contraseña: 'ficticia' });
    expect(limiter.consume).toHaveBeenCalledTimes(1);
    expect(limiter.consume.mock.calls[0][0]).toBe('register');
    expect(resolveDirectOrigin(limiter.consume.mock.calls[0][1], false)).toBe('127.0.0.1');
    expect(limiter.consume.mock.calls[0][2]).toBe(false);
    expect(result.text).not.toMatch(/contraseña|hash|token|ficticia/);
  });
  it.each(['register', 'verify', 'resend'] as const)('rechaza rol y operadores extra en %s, contabilizando la solicitud antes del DTO', async (operation) => {
    await setup();
    await request(app.getHttpServer()).post(`/api/v1/auth/${operation}`).send({ ...bodies[operation], rol: 'admin', $where: 'invalid' }).expect(400);
    expect(limiter.consume).toHaveBeenCalledTimes(1);
    expect(registration.register).not.toHaveBeenCalled(); expect(verification.verify).not.toHaveBeenCalled(); expect(resend.resend).not.toHaveBeenCalled();
  });
  it.each([123456, '12345', '1234567', '12345x', { $ne: null }])('rechaza código inválido %j sin invocar el caso de uso', async (codigo) => {
    await setup();
    await request(app.getHttpServer()).post('/api/v1/auth/verify').send({ correo: 'persona@example.invalid', codigo }).expect(400);
    expect(verification.verify).not.toHaveBeenCalled();
  });
  it('valida nombre vacío/espacios y limita tamaños sin recortar la contraseña', async () => {
    await setup();
    for (const body of [{ ...registerBody, nombre: '   ' }, { ...registerBody, nombre: 'a'.repeat(201) }, { ...registerBody, contraseña: 'a'.repeat(1025) }, { ...registerBody, correo: { $ne: null } }]) {
      await request(app.getHttpServer()).post('/api/v1/auth/register').send(body).expect(400);
    }
    await request(app.getHttpServer()).post('/api/v1/auth/register').send({ ...registerBody, contraseña: ' ficticia ' }).expect(202);
    expect(registration.register.mock.calls[0][0].contraseña).toBe(' ficticia ');
  });
  it('verifica con 200 o rechaza uniformemente con 400 sin emitir credenciales', async () => {
    await setup();
    await request(app.getHttpServer()).post('/api/v1/auth/verify').send(bodies.verify).expect(200).expect({ message: 'Correo verificado.' });
    expect(verification.verify).toHaveBeenCalledWith('persona@example.invalid', '012345');
    verification.verify.mockResolvedValue(false);
    const response = await request(app.getHttpServer()).post('/api/v1/auth/verify').send(bodies.verify).expect(400);
    expect(response.body.message).toBe('No se pudo verificar el código');
  });
  it('conserva la respuesta genérica en duplicado, reenvío sin efecto y estado heredado', async () => {
    await setup();
    for (let i = 0; i < 2; i++) await request(app.getHttpServer()).post('/api/v1/auth/register').send(registerBody).expect(202).expect({ message: 'Solicitud recibida.' });
    await request(app.getHttpServer()).post('/api/v1/auth/resend').send(bodies.resend).expect(202).expect({ message: 'Solicitud recibida.' });
    resend.resend.mockRejectedValueOnce(new VerificationStateUnavailableError());
    await request(app.getHttpServer()).post('/api/v1/auth/resend').send(bodies.resend).expect(202).expect({ message: 'Solicitud recibida.' });
    expect(resend.resend).toHaveBeenCalledWith('persona@example.invalid');
  });
  it.each(['register', 'resend'] as const)('no revela fallo de entrega posterior al commit en %s ni afirma envío', async (operation) => {
    await setup();
    (operation === 'register' ? registration.register : resend.resend).mockRejectedValueOnce(new VerificationDeliveryError());
    await request(app.getHttpServer()).post(`/api/v1/auth/${operation}`).send(bodies[operation]).expect(202).expect({ message: 'Solicitud recibida.' });
  });
  it.each(['register', 'verify', 'resend'] as const)('devuelve 429 por cuota %s antes de consultar índices o cuentas', async (operation) => {
    await setup(); limiter.consume.mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 30 });
    await request(app.getHttpServer()).post(`/api/v1/auth/${operation}`).send(bodies[operation]).expect(429);
    expect(limiter.consume.mock.calls[0][0]).toBe(operation); expect(indexLists).not.toHaveBeenCalled();
    expect(registration.register).not.toHaveBeenCalled(); expect(verification.verify).not.toHaveBeenCalled(); expect(resend.resend).not.toHaveBeenCalled();
  });
  it('falla cerrado si Redis cae, sin trabajo MongoDB posterior', async () => {
    await setup(); limiter.consume.mockRejectedValueOnce(new RateLimitUnavailableError());
    const result = await request(app.getHttpServer()).post('/api/v1/auth/verify').send(bodies.verify).expect(503);
    expect(result.body.message).toBe('Error interno del servidor'); expect(indexLists).not.toHaveBeenCalled();
  });
  it('bloquea registro y reenvío antes de escribir si falla el preflight SMTP', async () => {
    await setup(); transport.verify.mockRejectedValue(new Error('SMTP credentials private-secret'));
    for (const operation of ['register', 'resend'] as const) {
      const result = await request(app.getHttpServer()).post(`/api/v1/auth/${operation}`).send(bodies[operation]).expect(503);
      expect(result.text).not.toContain('private-secret');
    }
    expect(registration.register).not.toHaveBeenCalled(); expect(resend.resend).not.toHaveBeenCalled();
  });
  it.each([{ indexes: [] }, { indexes: [{ name: 'correo_1', key: { correo: 1 }, unique: true, hidden: true }] }])('bloquea índices ausentes/incompatibles %j antes del caso de uso', async ({ indexes }) => {
    await setup(); indexLists.mockResolvedValue(indexes);
    await request(app.getHttpServer()).post('/api/v1/auth/register').send(registerBody).expect(503);
    expect(registration.register).not.toHaveBeenCalled();
  });
  it('sanitiza errores internos sin exponer URI, contraseña ni traza', async () => {
    await setup(); verification.verify.mockRejectedValueOnce(new Error('mongodb://private-secret stack internal'));
    const result = await request(app.getHttpServer()).post('/api/v1/auth/verify').send(bodies.verify).expect(503);
    expect(result.body).toMatchObject({ statusCode: 503, message: 'Error interno del servidor', path: '/api/v1/auth/verify' });
    expect(result.text).not.toMatch(/private-secret|mongodb|stack|internal/);
  });
  it.each([{ enabled: false }, { proxy: true }])('bloquea todas las rutas y las oculta de Swagger con %j', async (options) => {
    await setup(options);
    for (const operation of ['register', 'verify', 'resend'] as const) await request(app.getHttpServer()).post(`/api/v1/auth/${operation}`).send(bodies[operation]).expect(503);
    const docs = await request(app.getHttpServer()).get('/docs-json').expect(200);
    expect(Object.keys(docs.body.paths)).not.toEqual(expect.arrayContaining(['/api/v1/auth/register', '/api/v1/auth/verify', '/api/v1/auth/resend']));
    expect(Object.keys(docs.body.paths).filter((path) => path.includes('/auth/'))).toHaveLength(0);
    expect(limiter.consume).not.toHaveBeenCalled();
  });
  it('el buzón simulado no habilita registro/reenvío públicos; verify tiene protecciones completas', async () => {
    await setup({ simulated: true });
    await request(app.getHttpServer()).post('/api/v1/auth/register').send(registerBody).expect(503);
    await request(app.getHttpServer()).post('/api/v1/auth/resend').send(bodies.resend).expect(503);
    await request(app.getHttpServer()).post('/api/v1/auth/verify').send(bodies.verify).expect(200);
    const docs = await request(app.getHttpServer()).get('/docs-json').expect(200);
    expect(docs.body.paths).not.toHaveProperty('/api/v1/auth/register'); expect(docs.body.paths).not.toHaveProperty('/api/v1/auth/resend');
    expect(docs.body.paths['/api/v1/auth/verify'].post.responses).toHaveProperty('200');
  });
  it('Swagger describe contratos habilitados y contraseña solo de escritura', async () => {
    await setup();
    const docs = await request(app.getHttpServer()).get('/docs-json').expect(200);
    for (const operation of ['register', 'verify', 'resend']) expect(docs.body.paths[`/api/v1/auth/${operation}`]).toHaveProperty('post');
    expect(docs.body.components.schemas.RegisterDto.properties.contraseña.writeOnly).toBe(true);
    expect(docs.body.components.schemas.RegisterDto.properties).not.toHaveProperty('rol');
    expect(docs.text).not.toMatch(/SMTP_PASSWORD|JWT_ACCESS_SECRET|private-secret/);
  });
});
