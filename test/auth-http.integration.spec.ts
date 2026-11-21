import { Global, INestApplication, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose, { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import { createTransport, SendMailOptions } from 'nodemailer';
import request from 'supertest';
import { configureApp } from '../src/configure-app';
import { AuthHttpModule } from '../src/modules/auth/auth-http.module';
import { VERIFICATION_MAILER } from '../src/modules/identity/application/verification-mailer';
import { SmtpVerificationMailer } from '../src/modules/identity/infrastructure/smtp-verification-mailer';
import { TokenCuenta, Usuario } from '../src/modules/identity/infrastructure/schemas/identity.schemas';
import { installIdentityIndexes } from '../src/modules/identity/infrastructure/identity-indexes';
import { optionalMongoTestScope, optionalRedisTestTarget } from './integration-isolation';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

const scope = optionalMongoTestScope(process.env.LETHICS_IDENTITY_TEST_URI, 'identity');
const redis = optionalRedisTestTarget(process.env.LETHICS_REDIS_TEST_URL);
(scope && redis ? describe : describe.skip)('HTTP + identidad real, MongoDB/Redis aislados y SMTP exclusivamente simulado', () => {
  let app: INestApplication, connection: Connection;
  const messages: Array<{ recipient: string; code: string }> = [];
  const transport = { verify: jest.fn().mockResolvedValue(true), close: jest.fn(), sendMail: jest.fn(async (message: SendMailOptions) => {
    const recipient = message.to as string;
    const text = message.text as string;
    const code = /\b([0-9]{6})\b/.exec(text)?.[1];
    if (!code) throw new Error('Mensaje de prueba inválido');
    messages.push({ recipient, code });
    return { accepted: [recipient], rejected: [] };
  }) };

  @Global()
  @Module({ providers: [{ provide: getConnectionToken(), useFactory: () => connection }], exports: [getConnectionToken()] })
  class TemporaryConnectionModule {}

  beforeAll(async () => {
    const temporary = await scope!.open();
    connection = mongoose.createConnection().setClient(temporary.client);
    // Fixture installation affects only the fresh, owned UUID database.
    await temporary.db.createCollection('usuarios'); await temporary.db.createCollection('tokens_cuenta');
    await installIdentityIndexes(temporary.db, `INSTALL INDEXES ${scope!.dbName}`);
    const settings = { NODE_ENV: 'test', AUTH_HTTP_ENABLED: true, AUTH_BEHIND_PROXY: false,
      JWT_ACCESS_SECRET_BASE64: randomBytes(32).toString('base64'), JWT_ACCESS_ISSUER: 'http-test', JWT_ACCESS_AUDIENCE: 'http-test', JWT_ACCESS_TTL_SECONDS: 900,
      VERIFICATION_CODE_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), RATE_LIMIT_HMAC_KEY_BASE64: randomBytes(32).toString('base64'),
      REDIS_URL: redis!.uri, RATE_LIMIT_NAMESPACE: redis!.namespace, RATE_LIMIT_VERIFY_MAX: 60, RATE_LIMIT_VERIFY_WINDOW_SECONDS: 600,
      RATE_LIMIT_REGISTER_MAX: 20, RATE_LIMIT_REGISTER_WINDOW_SECONDS: 3600, RATE_LIMIT_RESEND_MAX: 20, RATE_LIMIT_RESEND_WINDOW_SECONDS: 3600,
      VERIFICATION_ACCOUNT_FAILURES_PER_HOUR: 20, VERIFICATION_ACCOUNT_EMISSIONS_PER_HOUR: 5,
      SMTP_HOST: 'smtp.example.test', SMTP_PORT: 465, SMTP_SECURE: true, SMTP_USER: 'test-only', SMTP_PASSWORD: 'test-only', SMTP_FROM: 'verification@example.test',
    };
    (createTransport as jest.Mock).mockReturnValue(transport);
    // Explicit test fixture: real adapter with a mocked SMTP transport, never an external message.
    const simulatedSmtp = new SmtpVerificationMailer(new ConfigService(settings));
    const module = await Test.createTestingModule({ imports: [TemporaryConnectionModule,
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => settings] }), AuthHttpModule,
    ] }).overrideProvider(VERIFICATION_MAILER).useValue(simulatedSmtp).compile();
    app = module.createNestApplication(); configureApp(app); await app.init();
  }, 20000);
  afterAll(async () => {
    try { if (app) await app.close(); }
    finally {
      try { await scope?.close(); }
      finally { if (connection) await connection.close(); }
    }
  });
  it('registra concurrentemente un estudiante, oculta duplicados y verifica un único uso', async () => {
    const correo = 'http-register@example.test';
    const data = { nombre: ' Persona ficticia ', correo: ` ${correo.toUpperCase()} `, contraseña: 'ficticia' };
    await request(app.getHttpServer()).post('/api/v1/auth/register').send({ ...data, rol: 'admin' }).expect(400);
    const responses = await Promise.all([request(app.getHttpServer()).post('/api/v1/auth/register').send(data), request(app.getHttpServer()).post('/api/v1/auth/register').send(data)]);
    for (const response of responses) { expect(response.status).toBe(202); expect(response.body).toEqual({ message: 'Solicitud recibida.' }); }
    const user = await connection.model<Usuario>('Usuario').findOne({ correo });
    expect(user?.rol).toBe('estudiante'); expect(user?.verificadoEn).toBeNull();
    expect(messages.filter((message) => message.recipient === correo)).toHaveLength(1);
    const code = messages.find((message) => message.recipient === correo)!.code;
    const token = await connection.model<TokenCuenta>('TokenCuenta').findById(user!.seguridadVerificacion!.tokenActualId);
    expect(token!.expiraEn.getTime() - token!.creadoEn!.getTime()).toBe(300_000);
    const verifications = await Promise.all([request(app.getHttpServer()).post('/api/v1/auth/verify').send({ correo, codigo: code }), request(app.getHttpServer()).post('/api/v1/auth/verify').send({ correo, codigo: code })]);
    expect(verifications.map((result) => result.status).sort()).toEqual([200, 400]);
    await request(app.getHttpServer()).post('/api/v1/auth/verify').send({ correo, codigo: code }).expect(400);
    for (const address of [correo, 'missing@example.test']) await request(app.getHttpServer()).post('/api/v1/auth/resend').send({ correo: address }).expect(202).expect({ message: 'Solicitud recibida.' });
    expect(messages.filter((message) => message.recipient === correo)).toHaveLength(1);
  });
  it('respeta 60 segundos, revoca el código anterior y conserva fallos/emisiones entre reenvíos', async () => {
    const correo = 'http-resend@example.test';
    await request(app.getHttpServer()).post('/api/v1/auth/register').send({ nombre: 'Persona ficticia', correo, contraseña: 'ficticia' }).expect(202);
    const code = messages.find((message) => message.recipient === correo)!.code;
    const wrong = code === '000000' ? '000001' : '000000';
    await request(app.getHttpServer()).post('/api/v1/auth/verify').send({ correo, codigo: wrong }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/auth/resend').send({ correo }).expect(202);
    expect(messages.filter((message) => message.recipient === correo)).toHaveLength(1);
    const User = connection.model<Usuario>('Usuario'), Token = connection.model<TokenCuenta>('TokenCuenta');
    const before = await User.findOne({ correo });
    // Only synthetic data: move last emission back; never reset a security counter.
    await User.updateOne({ _id: before!._id }, { $set: { 'seguridadVerificacion.ultimaEmision': new Date(Date.now() - 60_001) } });
    await request(app.getHttpServer()).post('/api/v1/auth/resend').send({ correo }).expect(202).expect({ message: 'Solicitud recibida.' });
    const after = await User.findOne({ correo });
    expect(after!.seguridadVerificacion!.fallos).toBe(1); expect(after!.seguridadVerificacion!.emisiones).toBe(2);
    const oldToken = await Token.findById(before!.seguridadVerificacion!.tokenActualId);
    expect(oldToken!.intentosFallidos).toBe(1); expect(oldToken!.revocadoEn).toBeInstanceOf(Date);
    expect(messages.filter((message) => message.recipient === correo)).toHaveLength(2);
    const next = messages.filter((message) => message.recipient === correo)[1].code;
    expect(next).not.toBe(code);
    await request(app.getHttpServer()).post('/api/v1/auth/verify').send({ correo, codigo: code }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/auth/verify').send({ correo, codigo: next }).expect(200);
  });
  it('bloquea tras cinco fallos a través de HTTP sin verificar la cuenta', async () => {
    const correo = 'http-failures@example.test';
    await request(app.getHttpServer()).post('/api/v1/auth/register').send({ nombre: 'Persona ficticia', correo, contraseña: 'ficticia' }).expect(202);
    const code = messages.find((message) => message.recipient === correo)!.code;
    for (let i = 0; i < 5; i++) await request(app.getHttpServer()).post('/api/v1/auth/verify').send({ correo, codigo: code === '000000' ? '000001' : '000000' }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/auth/verify').send({ correo, codigo: code }).expect(400);
    const user = await connection.model<Usuario>('Usuario').findOne({ correo });
    expect(user!.verificadoEn).toBeNull(); expect(user!.seguridadVerificacion!.fallos).toBe(5);
  });
  it('conserva usuario/token confirmados y respuesta neutra ante fallo SMTP posterior al commit', async () => {
    const correo = 'http-mail-failure@example.test';
    transport.sendMail.mockRejectedValueOnce(new Error('private SMTP failure'));
    const result = await request(app.getHttpServer()).post('/api/v1/auth/register').send({ nombre: 'Persona ficticia', correo, contraseña: 'ficticia' }).expect(202);
    expect(result.body).toEqual({ message: 'Solicitud recibida.' }); expect(result.text).not.toContain('private');
    const user = await connection.model<Usuario>('Usuario').findOne({ correo });
    expect(user).not.toBeNull(); expect(user!.verificadoEn).toBeNull();
    expect(await connection.model<TokenCuenta>('TokenCuenta').exists({ _id: user!.seguridadVerificacion!.tokenActualId })).not.toBeNull();
    expect(messages.filter((message) => message.recipient === correo)).toHaveLength(0);
  });
  it('un reintento SMTP seguro conserva un único usuario/token, código y cuotas de emisión', async () => {
    const correo = 'http-safe-retry@example.test';
    const start = transport.sendMail.mock.calls.length;
    transport.sendMail.mockRejectedValueOnce(Object.assign(new Error('connection refused'), { code: 'ESOCKET', originalCode: 'ECONNREFUSED', command: 'CONN' }));
    await request(app.getHttpServer()).post('/api/v1/auth/register').send({ nombre: 'Estudiante sintético', correo, contraseña: 'synthetic-password' }).expect(202).expect({ message: 'Solicitud recibida.' });
    const calls = transport.sendMail.mock.calls.slice(start);
    expect(calls).toHaveLength(2); expect(calls[0][0]).toEqual(calls[1][0]);
    const User = connection.model<Usuario>('Usuario'), Token = connection.model<TokenCuenta>('TokenCuenta');
    const user = await User.findOne({ correo });
    expect(user!.verificadoEn).toBeNull(); expect(user!.seguridadVerificacion!.emisiones).toBe(1); expect(user!.seguridadVerificacion!.fallos).toBe(0);
    expect(await User.countDocuments({ correo })).toBe(1);
    expect(await Token.countDocuments({ usuarioId: user!._id })).toBe(1);
    const message = messages.find((entry) => entry.recipient === correo)!;
    await request(app.getHttpServer()).post('/api/v1/auth/verify').send({ correo, codigo: message.code }).expect(200);
  });
  it('un resultado incierto no se reintenta y permite recuperación solo por reenvío con cuotas', async () => {
    const correo = 'http-uncertain@example.test', password = 'synthetic-private-password';
    let originalCode = '';
    const start = transport.sendMail.mock.calls.length;
    const events: string[] = [];
    const spy = jest.spyOn(Logger.prototype, 'error').mockImplementation((...values: unknown[]) => { events.push(values.map(String).join(' ')); });
    transport.sendMail.mockImplementationOnce(async (message: SendMailOptions) => {
      originalCode = /\b([0-9]{6})\b/.exec(message.text as string)![1];
      throw Object.assign(new Error('private SMTP response'), { code: 'ETIMEDOUT', timeoutType: 'SOCKET_TIMEOUT', command: 'CONN' });
    });
    try {
      const result = await request(app.getHttpServer()).post('/api/v1/auth/register').send({ nombre: 'Estudiante sintético', correo, contraseña: password }).expect(202);
      expect(result.body).toEqual({ message: 'Solicitud recibida.' });
      expect(transport.sendMail.mock.calls.length - start).toBe(1);
      expect(messages.filter((entry) => entry.recipient === correo)).toHaveLength(0);
      const User = connection.model<Usuario>('Usuario'), Token = connection.model<TokenCuenta>('TokenCuenta');
      const user = await User.findOne({ correo }).select('+contraseñaHash');
      const token = await Token.findById(user!.seguridadVerificacion!.tokenActualId).select('+tokenHash');
      expect(user!.verificadoEn).toBeNull(); expect(user!.seguridadVerificacion!.emisiones).toBe(1);
      expect(token!.usadoEn).toBeNull(); expect(token!.revocadoEn).toBeNull();
      expect(token!.expiraEn.getTime() - token!.creadoEn!.getTime()).toBe(300_000);
      await request(app.getHttpServer()).post('/api/v1/auth/resend').send({ correo }).expect(202);
      expect(transport.sendMail.mock.calls.length - start).toBe(1);
      await User.updateOne({ _id: user!._id }, { $set: { 'seguridadVerificacion.ultimaEmision': new Date(Date.now() - 60_001) } });
      await request(app.getHttpServer()).post('/api/v1/auth/resend').send({ correo }).expect(202);
      const after = await User.findOne({ correo });
      expect(after!.seguridadVerificacion!.emisiones).toBe(2); expect(after!.seguridadVerificacion!.fallos).toBe(0);
      expect((await Token.findById(token!._id))!.revocadoEn).toBeInstanceOf(Date);
      const next = messages.find((entry) => entry.recipient === correo)!.code;
      expect(next).not.toBe(originalCode);
      await request(app.getHttpServer()).post('/api/v1/auth/verify').send({ correo, codigo: originalCode }).expect(400);
      const verified = await request(app.getHttpServer()).post('/api/v1/auth/verify').send({ correo, codigo: next }).expect(200);
      for (const secret of [password, originalCode, next, token!.tokenHash, user!.contraseñaHash, 'private SMTP response']) {
        expect(events.join('\n')).not.toContain(secret); expect(result.text + verified.text).not.toContain(secret);
      }
      expect(events).toContain('Entrega de verificación no confirmada');
    } finally { spy.mockRestore(); }
  });
});
