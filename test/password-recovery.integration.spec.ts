import { Global, INestApplication, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import mongoose, { Connection } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import { createTransport, SendMailOptions } from 'nodemailer';
import request from 'supertest';
import { configureApp } from '../src/configure-app';
import { AuthHttpModule } from '../src/modules/auth/auth-http.module';
import { UsersModule } from '../src/modules/users/users.module';
import { VERIFICATION_MAILER } from '../src/modules/identity/application/verification-mailer';
import { SmtpVerificationMailer } from '../src/modules/identity/infrastructure/smtp-verification-mailer';
import { PasswordService } from '../src/infrastructure/security/password.service';
import { OpaqueTokenService } from '../src/infrastructure/security/opaque-token.service';
import { OriginRateLimitService, RateLimitUnavailableError } from '../src/infrastructure/rate-limit/origin-rate-limit.service';
import { installIdentityIndexes } from '../src/modules/identity/infrastructure/identity-indexes';
import { PasswordRecoveryService } from '../src/modules/identity/application/password-recovery.service';
import { optionalMongoTestScope, optionalRedisTestTarget, createRedisTestTarget } from './integration-isolation';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
const scope = optionalMongoTestScope(process.env.LETHICS_IDENTITY_TEST_URI, 'identity');
const redis = optionalRedisTestTarget(process.env.LETHICS_REDIS_TEST_URL);
(scope && redis ? describe : describe.skip)('Recuperación HTTP transaccional aislada', () => {
  let app: INestApplication, connection: Connection;
  const oldPassword = 'synthetic-old-password', newPassword = 'synthetic-new-password', origin = 'http://localhost:3000';
  const messages: Array<{ correo: string; token: string }> = [], logs: string[] = [], spies: jest.SpyInstance[] = [];
  const transport = { verify: jest.fn().mockResolvedValue(true), close: jest.fn(), sendMail: jest.fn(async (message: SendMailOptions) => {
    const correo = message.to as string, token = /Tu token de recuperación es ([A-Za-z0-9_-]{43})\./.exec(message.text as string)?.[1];
    if (!correo.endsWith('@example.test') || !token) throw new Error('Mensaje sintético inválido');
    messages.push({ correo, token }); return { accepted: [correo], rejected: [] };
  }) };
  const settings = { NODE_ENV: 'test', AUTH_HTTP_ENABLED: true, AUTH_BEHIND_PROXY: false, AUTH_BROWSER_ORIGIN: origin, AUTH_REFRESH_TTL_SECONDS: 604800, AUTH_REFRESH_COOKIE_SECURE: false,
    JWT_ACCESS_SECRET_BASE64: randomBytes(32).toString('base64'), JWT_ACCESS_ISSUER: 'recovery-test', JWT_ACCESS_AUDIENCE: 'recovery-test', JWT_ACCESS_TTL_SECONDS: 900,
    VERIFICATION_CODE_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), RATE_LIMIT_HMAC_KEY_BASE64: randomBytes(32).toString('base64'),
    REDIS_URL: redis?.uri, RATE_LIMIT_NAMESPACE: redis?.namespace,
    RATE_LIMIT_PASSWORD_FORGOT_MAX: 200, RATE_LIMIT_PASSWORD_RESET_MAX: 200, RATE_LIMIT_LOGIN_MAX: 100, RATE_LIMIT_REGISTER_MAX: 20, RATE_LIMIT_REGISTER_WINDOW_SECONDS: 3600,
    RATE_LIMIT_VERIFY_MAX: 60, RATE_LIMIT_VERIFY_WINDOW_SECONDS: 600, RATE_LIMIT_RESEND_MAX: 20, RATE_LIMIT_RESEND_WINDOW_SECONDS: 3600,
    VERIFICATION_ACCOUNT_FAILURES_PER_HOUR: 20, VERIFICATION_ACCOUNT_EMISSIONS_PER_HOUR: 5,
    SMTP_HOST: 'smtp.example.test', SMTP_PORT: 465, SMTP_SECURE: true, SMTP_USER: 'test-only', SMTP_PASSWORD: 'test-only', SMTP_FROM: 'verification@example.test',
  };
  @Global()
  @Module({ providers: [{ provide: getConnectionToken(), useFactory: () => connection }], exports: [getConnectionToken()] })
  class TemporaryConnectionModule {}
  beforeAll(async () => {
    for (const level of ['log', 'error', 'warn', 'debug', 'verbose'] as const) spies.push(jest.spyOn(Logger.prototype, level).mockImplementation((...values: unknown[]) => { logs.push(values.map(String).join(' ')); }));
    const temporary = await scope!.open(); connection = mongoose.createConnection().setClient(temporary.client);
    for (const name of ['usuarios', 'tokens_cuenta', 'sesiones']) await temporary.db.createCollection(name);
    await installIdentityIndexes(temporary.db, `INSTALL INDEXES ${scope!.dbName}`);
    (createTransport as jest.Mock).mockReturnValue(transport);
    const module = await Test.createTestingModule({ imports: [TemporaryConnectionModule, ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => settings] }), AuthHttpModule, UsersModule] })
      .overrideProvider(VERIFICATION_MAILER).useValue(new SmtpVerificationMailer(new ConfigService(settings))).compile();
    app = module.createNestApplication(); configureApp(app); await app.init();
  }, 20000);
  afterAll(async () => {
    try { if (app) await app.close(); } finally { try { await scope?.close(); } finally { try { if (connection) await connection.close(); } finally { spies.forEach((spy) => spy.mockRestore()); } } }
  });
  const users = () => connection.db!.collection('usuarios'), tokens = () => connection.db!.collection('tokens_cuenta'), sessions = () => connection.db!.collection('sesiones');
  const createUser = async (verified = true) => {
    const correo = `${randomUUID()}@example.test`;
    const user = { nombre: 'Sintético', correo, contraseñaHash: await app.get(PasswordService).hash(oldPassword), rol: 'estudiante', verificadoEn: verified ? new Date() : null };
    const inserted = await users().insertOne(user); return { ...user, _id: inserted.insertedId };
  };
  const forgotRequest = (correo: string) => request(app.getHttpServer()).post('/api/v1/auth/password/forgot').send({ correo });
  const settled = () => app.get(PasswordRecoveryService).waitForPendingRequests();
  const forgot = (correo: string) => ({ expect: async (status: number) => { const response = await forgotRequest(correo).expect(status); await settled(); return response; } });
  const reset = (token: string, nuevaContraseña = newPassword) => request(app.getHttpServer()).post('/api/v1/auth/password/reset').send({ token, nuevaContraseña });
  const login = (correo: string, contraseña = oldPassword) => request(app.getHttpServer()).post('/api/v1/auth/login').send({ correo, contraseña });
  const issued = async (correo: string) => { await forgot(correo).expect(202); return messages.filter((message) => message.correo === correo).at(-1)!.token; };
  const digest = (token: string) => app.get(OpaqueTokenService).digest('password-reset', token);
  const cookie = (response: request.Response): string => response.headers['set-cookie'][0].split(';')[0];
  const renew = (value: string) => request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Origin', origin).set('Cookie', value).send({});

  it('respuesta uniforme para existente, inexistente y no verificado; normaliza correo', async () => {
    const user = await createUser(), unverified = await createUser(false);
    const existing = await forgot(` ${user.correo.toUpperCase()} `).expect(202);
    for (const correo of ['missing@example.test', unverified.correo]) expect((await forgot(correo).expect(202)).body).toEqual(existing.body);
    expect(messages.filter((message) => message.correo === user.correo)).toHaveLength(1);
    expect(messages.filter((message) => message.correo === unverified.correo)).toHaveLength(0);
    expect(existing.text).not.toContain(user.correo); expect(existing.headers['cache-control']).toBe('no-store');
  });
  it('cambia contraseña, consume token y revoca todas las sesiones sin afectar otra cuenta', async () => {
    const user = await createUser(), other = await createUser();
    const first = await login(user.correo).expect(200), second = await login(user.correo).expect(200), independent = await login(other.correo).expect(200);
    const token = await issued(user.correo), before = (await tokens().findOne({ tokenHash: digest(token) }))!;
    expect(before.tipo).toBe('recuperacion'); expect(before.expiraEn.getTime() - before.creadoEn.getTime()).toBe(900000);
    expect(JSON.stringify(before)).not.toContain(token); expect(digest(token)).not.toBe(app.get(OpaqueTokenService).digest('refresh', token));
    const response = await reset(token).expect(200); expect(response.body).toEqual({ message: 'Contraseña restablecida.' });
    expect((await tokens().findOne({ _id: before._id }))!.usadoEn).toBeInstanceOf(Date);
    expect(await sessions().countDocuments({ usuarioId: user._id, revocadaEn: null })).toBe(0);
    await login(user.correo).expect(401); await login(user.correo, newPassword).expect(200);
    await renew(cookie(first)).expect(401); await renew(cookie(second)).expect(401); await renew(cookie(independent)).expect(200);
    await request(app.getHttpServer()).get('/api/v1/users/me').auth(first.body.accessToken, { type: 'bearer' }).expect(200);
    await reset(token).expect(400);
    const after = (await users().findOne({ _id: user._id }))!;
    expect(await app.get(PasswordService).verify(after.contraseñaHash, newPassword)).toBe(true);
    for (const secret of [token, digest(token), oldPassword, newPassword, after.contraseñaHash, settings.SMTP_PASSWORD, settings.JWT_ACCESS_SECRET_BASE64]) expect(response.text + logs.join('\n')).not.toContain(secret);
  });
  it.each(['expired', 'revoked', 'wrong', 'verification-purpose'] as const)('rechaza token %s sin cambiar contraseña ni sesiones', async (state) => {
    const user = await createUser(), token = await issued(user.correo), hash = digest(token), before = await users().findOne({ _id: user._id });
    if (state !== 'wrong') await tokens().updateOne({ tokenHash: hash }, { $set: state === 'expired' ? { expiraEn: new Date(Date.now() - 1) } : state === 'revoked' ? { revocadoEn: new Date() } : { tipo: 'verificacion' } });
    await reset(state === 'wrong' ? app.get(OpaqueTokenService).generate() : token).expect(400);
    expect(await users().findOne({ _id: user._id })).toEqual(before);
  });
  it('rechaza contraseñas/entradas inválidas y campos ajenos sin consumir token', async () => {
    const user = await createUser(), token = await issued(user.correo);
    for (const value of ['', 'x'.repeat(1025), 123, null]) await request(app.getHttpServer()).post('/api/v1/auth/password/reset').send({ token, nuevaContraseña: value }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/auth/password/reset').send({ token, nuevaContraseña: newPassword, usuarioId: user._id, rol: 'otro' }).expect(400);
    await reset('invalid').expect(400); expect((await tokens().findOne({ tokenHash: digest(token) }))!.usadoEn).toBeNull();
    await reset(token).expect(200);
  });
  it('dos reset concurrentes consumen el token una sola vez', async () => {
    const user = await createUser(), token = await issued(user.correo);
    const responses = await Promise.all([reset(token), reset(token)]);
    expect(responses.map((result) => result.status).sort()).toEqual([200, 400]);
  });
  it('emisión concurrente deja una única credencial vigente y no altera verificación', async () => {
    const user = await createUser();
    const responses = await Promise.all([forgotRequest(user.correo), forgotRequest(user.correo)]); await settled(); expect(responses.map((result) => result.status)).toEqual([202, 202]);
    const active = await tokens().find({ usuarioId: user._id, tipo: 'recuperacion', usadoEn: null, revocadoEn: null }).toArray(); expect(active).toHaveLength(1);
    const sent = messages.filter((message) => message.correo === user.correo); expect(sent.length).toBeGreaterThan(0);
    const current = sent.find((message) => digest(message.token) === active[0].tokenHash)!; expect(current).toBeDefined();
    for (const previous of sent.filter((message) => message !== current)) await reset(previous.token).expect(400);
    await reset(current.token).expect(200); expect((await users().findOne({ _id: user._id }))!.verificadoEn).toEqual(user.verificadoEn);
  });
  it('una nueva solicitud invalida el token anterior y cuotas de cuenta no se reinician', async () => {
    const user = await createUser(), old = await issued(user.correo), current = await issued(user.correo);
    expect(old).not.toBe(current); await reset(old).expect(400);
    await issued(user.correo); const count = messages.length; await forgot(user.correo).expect(202); expect(messages.length).toBe(count);
  });
  it('SMTP rechazado o incierto invalida token y responde uniformemente; permite solicitud posterior', async () => {
    const user = await createUser();
    transport.sendMail.mockRejectedValueOnce(Object.assign(new Error('synthetic-private-smtp'), { code: 'ETIMEDOUT', command: 'DATA' }));
    const count = transport.sendMail.mock.calls.length, response = await forgot(user.correo).expect(202);
    expect(transport.sendMail.mock.calls.length).toBe(count + 1);
    expect((await tokens().findOne({ usuarioId: user._id, tipo: 'recuperacion' }))!.revocadoEn).toBeInstanceOf(Date);
    expect(response.body).toEqual((await forgot('missing-again@example.test').expect(202)).body);
    expect(response.text + logs.join('\n')).not.toContain('synthetic-private-smtp');
    await reset(await issued(user.correo)).expect(200);
  });
  it('falla cerrado en Redis por origen y cuenta, sin crear tokens', async () => {
    const user = await createUser();
    for (const method of ['consume', 'consumeAccount'] as const) {
      const spy = jest.spyOn(app.get(OriginRateLimitService), method).mockRejectedValueOnce(new RateLimitUnavailableError());
      try { await forgot(user.correo).expect(503); } finally { spy.mockRestore(); }
    }
    expect(await tokens().countDocuments({ usuarioId: user._id })).toBe(0);
    const spy = jest.spyOn(app.get(OriginRateLimitService), 'consume').mockRejectedValueOnce(new RateLimitUnavailableError());
    try { await reset(app.get(OpaqueTokenService).generate()).expect(503); } finally { spy.mockRestore(); }
  });
  it('la respuesta no espera al lookup de cuenta ni a SMTP, y un fallo posterior no envía', async () => {
    const user = await createUser(), model = connection.model('Usuario');
    let fail!: (reason: Error) => void;
    const deferred = new Promise<never>((_resolve, reject) => { fail = reject; });
    const spy = jest.spyOn(model, 'findOne').mockReturnValueOnce({ lean: () => deferred } as never);
    try {
      const response = await forgotRequest(user.correo).expect(202);
      expect(response.text).not.toContain(user.correo);
      fail(new Error('synthetic-private-deferred-lookup')); await settled();
      expect(await tokens().countDocuments({ usuarioId: user._id })).toBe(0);
      expect(messages.some((message) => message.correo === user.correo)).toBe(false);
      expect(logs.join('\n')).not.toContain('synthetic-private-deferred-lookup');
    } finally { spy.mockRestore(); }
  });
  it('rollback si falla revocación MongoDB conserva contraseña, token y sesiones', async () => {
    const user = await createUser(), session = await login(user.correo).expect(200), token = await issued(user.correo), before = await users().findOne({ _id: user._id });
    const spy = jest.spyOn(connection.model('Sesion'), 'updateMany').mockRejectedValueOnce(new Error('synthetic-private-mongo'));
    try { const result = await reset(token).expect(503); expect(result.text + logs.join('\n')).not.toContain('synthetic-private-mongo'); } finally { spy.mockRestore(); }
    expect(await users().findOne({ _id: user._id })).toEqual(before); expect((await tokens().findOne({ tokenHash: digest(token) }))!.usadoEn).toBeNull();
    await renew(cookie(session)).expect(200); await reset(token).expect(200);
  });
  it('login que validó contraseña antigua antes del reset no crea una sesión posterior', async () => {
    const user = await createUser(), token = await issued(user.correo), passwords = app.get(PasswordService), original = passwords.hash.bind(passwords);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; }), blocked = new Promise<void>((resolve) => { release = resolve; });
    const spy = jest.spyOn(passwords, 'hash').mockImplementation(async (value) => { if (value === oldPassword) { entered(); await blocked; } return original(value); });
    const pending = login(user.correo).then((result) => result);
    try { await waiting; await reset(token).expect(200); release(); expect((await pending).status).toBe(401); } finally { release(); spy.mockRestore(); }
    expect(await sessions().countDocuments({ usuarioId: user._id, revocadaEn: null })).toBe(0); await login(user.correo, newPassword).expect(200);
  });
  it('reset y refresh simultáneos no dejan sucesor renovable', async () => {
    const user = await createUser(), session = await login(user.correo).expect(200), token = await issued(user.correo);
    const [changed, refresh] = await Promise.all([reset(token), renew(cookie(session))]);
    expect(changed.status).toBe(200); expect([200, 401]).toContain(refresh.status);
    expect(await sessions().countDocuments({ usuarioId: user._id, revocadaEn: null })).toBe(0);
    if (refresh.status === 200) await renew(cookie(refresh)).expect(401);
  });
  it('protege Origin/JSON y aplica cuotas independientes por origen', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/password/forgot').set('Origin', 'https://attacker.example.test').send({ correo: 'nobody@example.test' }).expect(403);
    await request(app.getHttpServer()).post('/api/v1/auth/password/reset').type('form').send({}).expect(415);
    const config = app.get(ConfigService), previous = config.get('RATE_LIMIT_NAMESPACE');
    config.set('RATE_LIMIT_NAMESPACE', createRedisTestTarget(redis!.uri).namespace); config.set('RATE_LIMIT_PASSWORD_FORGOT_MAX', 1); config.set('RATE_LIMIT_PASSWORD_RESET_MAX', 1);
    try { await forgot('quota@example.test').expect(202); await forgot('quota2@example.test').expect(429); await reset(app.get(OpaqueTokenService).generate()).expect(400); await reset(app.get(OpaqueTokenService).generate()).expect(429); }
    finally { config.set('RATE_LIMIT_NAMESPACE', previous); config.set('RATE_LIMIT_PASSWORD_FORGOT_MAX', 200); config.set('RATE_LIMIT_PASSWORD_RESET_MAX', 200); }
  });
});
