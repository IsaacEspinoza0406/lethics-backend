import { Global, INestApplication, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose, { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { configureApp } from '../src/configure-app';
import { AuthHttpModule } from '../src/modules/auth/auth-http.module';
import { UsersModule } from '../src/modules/users/users.module';
import { VERIFICATION_MAILER, VerificationDeliveryError } from '../src/modules/identity/application/verification-mailer';
import { verificationMailerFromConfig } from '../src/modules/identity/infrastructure/verification-mailer.factory';
import { SmtpVerificationMailer } from '../src/modules/identity/infrastructure/smtp-verification-mailer';
import { installIdentityIndexes } from '../src/modules/identity/infrastructure/identity-indexes';
import { TokenCuenta, Usuario } from '../src/modules/identity/infrastructure/schemas/identity.schemas';
import { createMongoTestScope, createRedisTestTarget } from './integration-isolation';
import { createFaultSmtpServer } from './smtp-fault-server';
import { PasswordService } from '../src/infrastructure/security/password.service';
import { OpaqueTokenService } from '../src/infrastructure/security/opaque-token.service';
import { PasswordRecoveryService } from '../src/modules/identity/application/password-recovery.service';

// Opt-in only. All other tests retain the default simulated factory for NODE_ENV=test.
const api = process.env.LETHICS_MAILPIT_API_URL;
const enabled = Boolean(api);
if (enabled) {
  const address = new URL(api!);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port || address.pathname !== '/' || address.username || address.password || address.search || address.hash || !process.env.NODE_EXTRA_CA_CERTS || !process.env.LETHICS_IDENTITY_TEST_URI || !process.env.LETHICS_REDIS_TEST_URL) throw new Error('Mailpit requiere destino local explícito y conexiones aisladas');
}
const scope = enabled ? createMongoTestScope(process.env.LETHICS_IDENTITY_TEST_URI!, 'identity') : undefined;
const redis = enabled ? createRedisTestTarget(process.env.LETHICS_REDIS_TEST_URL!) : undefined;
const smtpPort = Number(process.env.LETHICS_MAILPIT_SMTP_PORT);
if (enabled && (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535)) throw new Error('Puerto SMTP local inválido');

interface MailpitMessage { ID: string; To: Array<{ Address: string }>; Subject: string; Text: string }

(enabled ? describe : describe.skip)('HTTP → SMTP STARTTLS real → Mailpit → verificación (aislado)', () => {
  let app: INestApplication, connection: Connection;
  const logs: string[] = [];
  const spies: jest.SpyInstance[] = [];
  const settings = {
    NODE_ENV: 'test', AUTH_HTTP_ENABLED: true, AUTH_BEHIND_PROXY: false,
    AUTH_REFRESH_TTL_SECONDS: 604800, AUTH_REFRESH_COOKIE_SECURE: false, AUTH_BROWSER_ORIGIN: 'http://localhost:3000',
    JWT_ACCESS_SECRET_BASE64: randomBytes(32).toString('base64'), JWT_ACCESS_ISSUER: 'mailpit-test', JWT_ACCESS_AUDIENCE: 'mailpit-test', JWT_ACCESS_TTL_SECONDS: 900,
    VERIFICATION_CODE_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), RATE_LIMIT_HMAC_KEY_BASE64: randomBytes(32).toString('base64'),
    REDIS_URL: redis?.uri, RATE_LIMIT_NAMESPACE: redis?.namespace,
    RATE_LIMIT_VERIFY_MAX: 60, RATE_LIMIT_VERIFY_WINDOW_SECONDS: 600, RATE_LIMIT_REGISTER_MAX: 20, RATE_LIMIT_REGISTER_WINDOW_SECONDS: 3600, RATE_LIMIT_RESEND_MAX: 20, RATE_LIMIT_RESEND_WINDOW_SECONDS: 3600,
    VERIFICATION_ACCOUNT_FAILURES_PER_HOUR: 20, VERIFICATION_ACCOUNT_EMISSIONS_PER_HOUR: 5,
    VERIFICATION_MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'localhost', SMTP_PORT: smtpPort, SMTP_SECURE: false,
    SMTP_USER: 'mailpit', SMTP_PASSWORD: 'mailpit-local-only', SMTP_FROM: 'verificacion@example.test',
  };

  @Global()
  @Module({ providers: [{ provide: getConnectionToken(), useFactory: () => connection }], exports: [getConnectionToken()] })
  class TemporaryConnectionModule {}

  async function json(path: string): Promise<unknown> {
    const response = await fetch(`${api}${path}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('API Mailpit no disponible');
    return response.json();
  }
  async function received(recipient: string): Promise<MailpitMessage[]> {
    const listing = await json('/api/v1/messages') as { messages: MailpitMessage[] };
    const own = listing.messages.filter((message) => message.To.some((to) => to.Address === recipient));
    return Promise.all(own.map((message) => json(`/api/v1/message/${encodeURIComponent(message.ID)}`) as Promise<MailpitMessage>));
  }
  function code(message: MailpitMessage): string {
    const match = /Tu código de verificación es ([0-9]{6})\./.exec(message.Text);
    if (!match) throw new Error('Contenido de verificación inválido');
    return match[1];
  }
  beforeAll(async () => {
    for (const level of ['log', 'error', 'warn', 'debug', 'verbose'] as const) spies.push(jest.spyOn(Logger.prototype, level).mockImplementation((...values: unknown[]) => { logs.push(values.map(String).join(' ')); }));
    const temporary = await scope!.open();
    connection = mongoose.createConnection().setClient(temporary.client);
    await temporary.db.createCollection('usuarios'); await temporary.db.createCollection('tokens_cuenta'); await temporary.db.createCollection('sesiones');
    await installIdentityIndexes(temporary.db, `INSTALL INDEXES ${scope!.dbName}`);
    const module = await Test.createTestingModule({ imports: [TemporaryConnectionModule,
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => settings] }), AuthHttpModule, UsersModule,
    ] }).overrideProvider(VERIFICATION_MAILER).useFactory({ factory: () => verificationMailerFromConfig(new ConfigService({ ...settings, NODE_ENV: 'development' })) }).compile();
    app = module.createNestApplication(); configureApp(app); await app.init();
  }, 20000);
  afterAll(async () => {
    try { if (app) await app.close(); }
    finally {
      try { await scope?.close(); }
      finally { try { if (connection) await connection.close(); } finally { for (const spy of spies) spy.mockRestore(); } }
    }
  });

  it('registra estudiante, recibe correo real, reenvía y verifica una sola vez sin filtrar secretos', async () => {
    const correo = `student-${randomUUID()}@example.test`, password = `synthetic-${randomUUID()}`;
    const result = await request(app.getHttpServer()).post('/api/v1/auth/register').send({ nombre: 'Estudiante sintético', correo, contraseña: password }).expect(202);
    expect(result.body).toEqual({ message: 'Solicitud recibida.' });
    const User = connection.model<Usuario>('Usuario'), Token = connection.model<TokenCuenta>('TokenCuenta');
    const before = await User.findOne({ correo });
    expect(before!.rol).toBe('estudiante'); expect(before!.verificadoEn).toBeNull();
    const messages = await received(correo);
    expect(messages).toHaveLength(1);
    expect(messages[0].To.map((to) => to.Address)).toEqual([correo]);
    expect(messages[0].Subject).toBe('Verificación de correo — Lethics');
    expect(messages[0].Text).toContain('Vence en cinco minutos.');
    const first = code(messages[0]);
    await request(app.getHttpServer()).post('/api/v1/auth/resend').send({ correo }).expect(202);
    expect(await received(correo)).toHaveLength(1);
    // Change only this synthetic timestamp; retain all quotas and attempts.
    await User.updateOne({ _id: before!._id }, { $set: { 'seguridadVerificacion.ultimaEmision': new Date(Date.now() - 60_001) } });
    await request(app.getHttpServer()).post('/api/v1/auth/resend').send({ correo }).expect(202).expect({ message: 'Solicitud recibida.' });
    const resent = await received(correo);
    expect(resent).toHaveLength(2);
    const next = code(resent.find((message) => message.ID !== messages[0].ID)!);
    const previous = await Token.findById(before!.seguridadVerificacion!.tokenActualId);
    expect(previous!.revocadoEn).toBeInstanceOf(Date);
    await request(app.getHttpServer()).post('/api/v1/auth/verify').send({ correo, codigo: first }).expect(400);
    const verified = await request(app.getHttpServer()).post('/api/v1/auth/verify').send({ correo, codigo: next }).expect(200);
    expect(verified.body).toEqual({ message: 'Correo verificado.' });
    await request(app.getHttpServer()).post('/api/v1/auth/verify').send({ correo, codigo: next }).expect(400);
    const after = await User.findOne({ correo });
    expect(after!.verificadoEn).toBeInstanceOf(Date);
    expect(after!.seguridadVerificacion!.emisiones).toBe(2);
    const token = await Token.findById(after!.seguridadVerificacion!.tokenActualId).select('+tokenHash');
    expect(token!.usadoEn).toBeInstanceOf(Date);
    expect(typeof token!.tokenHash).toBe('string');
    for (const secret of [password, first, next, token!.tokenHash, settings.JWT_ACCESS_SECRET_BASE64, settings.VERIFICATION_CODE_HMAC_KEY_BASE64, settings.RATE_LIMIT_HMAC_KEY_BASE64]) {
      expect(logs.join('\n')).not.toContain(secret);
      expect(result.text + verified.text).not.toContain(secret);
    }
  }, 25000);

  it('recuperación completa: correo SMTP real a Mailpit, cambio de contraseña y sesiones revocadas', async () => {
    const correo = `recovery-${randomUUID()}@example.test`, oldPassword = `old-${randomUUID()}`, nextPassword = `new-${randomUUID()}`;
    const user = await connection.db!.collection('usuarios').insertOne({ nombre: 'Recuperación sintética', correo, rol: 'estudiante', verificadoEn: new Date(), contraseñaHash: await app.get(PasswordService).hash(oldPassword) });
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ correo, contraseña: oldPassword }).expect(200);
    const response = await request(app.getHttpServer()).post('/api/v1/auth/password/forgot').send({ correo }).expect(202);
    await app.get(PasswordRecoveryService).waitForPendingRequests();
    const messages = await received(correo); expect(messages).toHaveLength(1);
    expect(messages[0].Subject).toBe('Recuperación de contraseña — Lethics'); expect(messages[0].To.map((to) => to.Address)).toEqual([correo]);
    const token = /Tu token de recuperación es ([A-Za-z0-9_-]{43})\./.exec(messages[0].Text)![1]; expect(messages[0].Text).toContain('Vence en 15 minutos.');
    const tokenHash = app.get(OpaqueTokenService).digest('password-reset', token);
    const stored = (await connection.db!.collection('tokens_cuenta').findOne({ usuarioId: user.insertedId, tipo: 'recuperacion' }))!;
    expect(stored.tokenHash).toBe(tokenHash); expect(JSON.stringify(stored)).not.toContain(token);
    const reset = await request(app.getHttpServer()).post('/api/v1/auth/password/reset').send({ token, nuevaContraseña: nextPassword }).expect(200);
    await request(app.getHttpServer()).post('/api/v1/auth/password/reset').send({ token, nuevaContraseña: nextPassword }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/auth/login').send({ correo, contraseña: oldPassword }).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/login').send({ correo, contraseña: nextPassword }).expect(200);
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Origin', settings.AUTH_BROWSER_ORIGIN).set('Cookie', login.headers['set-cookie'][0].split(';')[0]).send({}).expect(401);
    for (const secret of [token, tokenHash, oldPassword, nextPassword, settings.SMTP_PASSWORD]) expect(response.text + reset.text + logs.join('\n')).not.toContain(secret);
  }, 25000);

  it('recorrido completo de una cuenta: registro → verificación → login → perfil → refresh → logout → recuperación → reset → nuevo login', async () => {
    const correo = `journey-${randomUUID()}@example.test`, password = `old-${randomUUID()}`, newPassword = `new-${randomUUID()}`;
    const call = (path: string, body: object) => request(app.getHttpServer()).post(`/api/v1/auth/${path}`).send(body);
    const pair = (response: request.Response): string => response.headers['set-cookie'][0].split(';')[0];
    const command = (path: string, cookie: string) => request(app.getHttpServer()).post(`/api/v1/auth/${path}`).set('Origin', settings.AUTH_BROWSER_ORIGIN).set('Cookie', cookie).send({});
    const responses: request.Response[] = [];
    responses.push(await call('register', { nombre: 'Recorrido sintético', correo, contraseña: password }).expect(202));
    await call('login', { correo, contraseña: password }).expect(401);
    const verification = (await received(correo)).find((message) => message.Subject === 'Verificación de correo — Lethics')!;
    const verificationCode = code(verification);
    responses.push(await call('verify', { correo, codigo: verificationCode }).expect(200));
    const login = await call('login', { correo, contraseña: password }).expect(200); responses.push(login);
    const me = await request(app.getHttpServer()).get('/api/v1/users/me').auth(login.body.accessToken, { type: 'bearer' }).expect(200); responses.push(me);
    expect(me.body).toEqual({ id: expect.any(String), nombre: 'Recorrido sintético', correo, rol: 'estudiante' });
    const refreshed = await command('refresh', pair(login)).expect(200); responses.push(refreshed);
    expect(pair(refreshed)).not.toBe(pair(login)); expect(refreshed.body.accessToken).not.toBe(login.body.accessToken);
    const loggedOut = await command('logout', pair(refreshed)).expect(204); responses.push(loggedOut);
    expect(loggedOut.headers['set-cookie'][0]).toContain('Expires=Thu, 01 Jan 1970');
    await command('refresh', pair(refreshed)).expect(401);
    // Actual guarantee: logout revokes refresh, not a still-valid access JWT.
    await request(app.getHttpServer()).get('/api/v1/users/me').auth(refreshed.body.accessToken, { type: 'bearer' }).expect(200);
    responses.push(await call('password/forgot', { correo }).expect(202));
    await app.get(PasswordRecoveryService).waitForPendingRequests();
    const recovery = (await received(correo)).find((message) => message.Subject === 'Recuperación de contraseña — Lethics')!;
    expect(recovery.To.map((recipient) => recipient.Address)).toEqual([correo]);
    const token = /Tu token de recuperación es ([A-Za-z0-9_-]{43})\./.exec(recovery.Text)![1];
    responses.push(await call('password/reset', { token, nuevaContraseña: newPassword }).expect(200));
    await call('password/reset', { token, nuevaContraseña: newPassword }).expect(400);
    await call('login', { correo, contraseña: password }).expect(401);
    const next = await call('login', { correo, contraseña: newPassword }).expect(200); responses.push(next);
    const nextProfile = await request(app.getHttpServer()).get('/api/v1/users/me').auth(next.body.accessToken, { type: 'bearer' }).expect(200);
    expect(nextProfile.body).toEqual(me.body);
    for (const response of [login, refreshed, next]) {
      expect(Object.keys(response.body).sort()).toEqual(['accessToken', 'expiresIn', 'tokenType']);
      expect(response.headers['set-cookie'][0]).toContain('HttpOnly'); expect(response.headers['set-cookie'][0]).toContain('SameSite=Strict');
      expect(response.headers['cache-control']).toBe('no-store');
    }
    const publicResponses = responses.map((response) => response.text).join('\n');
    for (const secret of [password, newPassword, verificationCode, token]) expect(publicResponses + logs.join('\n')).not.toContain(secret);
    for (const response of [login, refreshed, next]) expect(logs.join('\n')).not.toContain(response.body.accessToken);
    const user = await connection.model<Usuario>('Usuario').findOne({ correo }).select('+contraseñaHash');
    expect(user!.contraseñaHash).toMatch(/^\$argon2id\$/); expect(publicResponses + logs.join('\n')).not.toContain(user!.contraseñaHash);
  }, 25000);

  it('rechaza autenticación SMTP incorrecta sin exponer detalles ni aceptar entrega', async () => {
    const mailer = new SmtpVerificationMailer(new ConfigService({ ...settings, SMTP_PASSWORD: 'incorrect-synthetic-password' }));
    const correo = `failure-${randomUUID()}@example.test`;
    try {
      await expect(mailer.assertAvailable()).rejects.toBeInstanceOf(VerificationDeliveryError);
      await expect(mailer.sendVerification(correo, '012345')).rejects.toThrow('No se pudo procesar el envío');
      expect(await received(correo)).toHaveLength(0);
      expect(logs.join('\n')).not.toMatch(/incorrect-synthetic-password|012345/);
    } finally { mailer.onApplicationShutdown(); }
  }, 15000);
  it('reintenta un rechazo temporal anterior a DATA y transmite un único mensaje por TLS', async () => {
    const receiver = await createFaultSmtpServer('temporary');
    const mailer = new SmtpVerificationMailer(new ConfigService({ ...settings, SMTP_PORT: receiver.port, SMTP_SECURE: true }));
    try {
      await mailer.sendVerification('temporary@example.test', '012345');
      expect(receiver.connections).toBe(2); expect(receiver.messages).toHaveLength(1);
      expect(receiver.messages[0]).toContain('012345');
    } finally { mailer.onApplicationShutdown(); await receiver.close(); }
  }, 15000);
  it('no reintenta un rechazo permanente de destinatario ni transmite DATA', async () => {
    const receiver = await createFaultSmtpServer('permanent');
    const mailer = new SmtpVerificationMailer(new ConfigService({ ...settings, SMTP_PORT: receiver.port, SMTP_SECURE: true }));
    try {
      await expect(mailer.sendVerification('permanent@example.test', '012345')).rejects.toBeInstanceOf(VerificationDeliveryError);
      expect(receiver.connections).toBe(1); expect(receiver.messages).toHaveLength(0);
    } finally { mailer.onApplicationShutdown(); await receiver.close(); }
  }, 15000);
  it.each(['disconnect-after-data', 'timeout-after-data'] as const)('no reintenta un resultado incierto real: %s', async (fault) => {
    const receiver = await createFaultSmtpServer(fault);
    const mailer = new SmtpVerificationMailer(new ConfigService({ ...settings, SMTP_PORT: receiver.port, SMTP_SECURE: true }));
    try {
      await expect(mailer.sendVerification('uncertain@example.test', '012345')).rejects.toThrow('No se pudo procesar el envío');
      expect(receiver.connections).toBe(1); expect(receiver.messages).toHaveLength(1);
      expect(receiver.messages[0]).toContain('012345');
      expect(logs.join('\n')).not.toContain('012345');
    } finally { mailer.onApplicationShutdown(); await receiver.close(); }
  }, 20000);
});
