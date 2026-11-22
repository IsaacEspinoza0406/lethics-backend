import { Global, INestApplication, Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';
import mongoose, { Connection } from 'mongoose';
import { randomBytes } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { configureApp } from '../src/configure-app';
import { AuthHttpModule } from '../src/modules/auth/auth-http.module';
import { PasswordService } from '../src/infrastructure/security/password.service';
import { OpaqueTokenService } from '../src/infrastructure/security/opaque-token.service';
import { OriginRateLimitService, RateLimitUnavailableError } from '../src/infrastructure/rate-limit/origin-rate-limit.service';
import { Sesion } from '../src/modules/identity/infrastructure/schemas/identity.schemas';
import { installIdentityIndexes } from '../src/modules/identity/infrastructure/identity-indexes';
import { optionalMongoTestScope, optionalRedisTestTarget, createRedisTestTarget } from './integration-isolation';

const scope = optionalMongoTestScope(process.env.LETHICS_IDENTITY_TEST_URI, 'identity');
const redis = optionalRedisTestTarget(process.env.LETHICS_REDIS_TEST_URL);
(scope && redis ? describe : describe.skip)('Login HTTP con MongoDB/Redis aislados y criptografía real', () => {
  let app: INestApplication, connection: Connection, hash: string;
  const password = ' synthetic-password ';
  const logs: string[] = [], spies: jest.SpyInstance[] = [];
  const settings = { NODE_ENV: 'test', AUTH_HTTP_ENABLED: true, AUTH_BEHIND_PROXY: false, AUTH_REFRESH_TTL_SECONDS: 604800, AUTH_REFRESH_COOKIE_SECURE: false,
    JWT_ACCESS_SECRET_BASE64: randomBytes(32).toString('base64'), JWT_ACCESS_ISSUER: 'lethics-test', JWT_ACCESS_AUDIENCE: 'lethics-test', JWT_ACCESS_TTL_SECONDS: 900,
    VERIFICATION_CODE_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), RATE_LIMIT_HMAC_KEY_BASE64: randomBytes(32).toString('base64'),
    REDIS_URL: redis?.uri, RATE_LIMIT_NAMESPACE: redis?.namespace, RATE_LIMIT_LOGIN_MAX: 100, RATE_LIMIT_LOGIN_WINDOW_SECONDS: 600,
    RATE_LIMIT_VERIFY_MAX: 60, RATE_LIMIT_VERIFY_WINDOW_SECONDS: 600, RATE_LIMIT_REGISTER_MAX: 20, RATE_LIMIT_REGISTER_WINDOW_SECONDS: 3600, RATE_LIMIT_RESEND_MAX: 20, RATE_LIMIT_RESEND_WINDOW_SECONDS: 3600,
    VERIFICATION_ACCOUNT_FAILURES_PER_HOUR: 20, VERIFICATION_ACCOUNT_EMISSIONS_PER_HOUR: 5,
  };
  @Global()
  @Module({ providers: [{ provide: getConnectionToken(), useFactory: () => connection }], exports: [getConnectionToken()] })
  class TemporaryConnectionModule {}

  beforeAll(async () => {
    for (const level of ['log', 'error', 'warn', 'debug', 'verbose'] as const) spies.push(jest.spyOn(Logger.prototype, level).mockImplementation((...values: unknown[]) => { logs.push(values.map(String).join(' ')); }));
    const temporary = await scope!.open();
    connection = mongoose.createConnection().setClient(temporary.client);
    for (const name of ['usuarios', 'tokens_cuenta', 'sesiones']) await temporary.db.createCollection(name);
    await installIdentityIndexes(temporary.db, `INSTALL INDEXES ${scope!.dbName}`);
    hash = await new PasswordService().hash(password);
    // Only synthetic raw fixtures: malformed security state cannot pass Mongoose validators.
    await temporary.db.collection('usuarios').insertMany([
      { correo: 'verified@example.test', nombre: 'Estudiante', contraseñaHash: hash, rol: 'estudiante', verificadoEn: new Date() },
      { correo: 'unverified@example.test', nombre: 'Estudiante', contraseñaHash: hash, rol: 'estudiante', verificadoEn: null },
      { correo: 'restricted@example.test', nombre: 'Estudiante', contraseñaHash: hash, rol: 'estudiante', verificadoEn: new Date(), seguridadVerificacion: { fallos: 99 } },
      { correo: 'invalid-hash@example.test', nombre: 'Estudiante', contraseñaHash: 'invalid', rol: 'estudiante', verificadoEn: new Date() },
    ]);
    const module = await Test.createTestingModule({ imports: [TemporaryConnectionModule, ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => settings] }), AuthHttpModule] }).compile();
    app = module.createNestApplication(); configureApp(app); await app.init();
  }, 20000);
  afterAll(async () => {
    try { if (app) await app.close(); }
    finally { try { await scope?.close(); } finally { try { if (connection) await connection.close(); } finally { for (const spy of spies) spy.mockRestore(); } } }
  });
  const login = (correo = 'verified@example.test', contraseña = password) => request(app.getHttpServer()).post('/api/v1/auth/login').send({ correo, contraseña });

  it('autentica, firma claims estrictos y persiste exclusivamente el hash de refresh', async () => {
    const response = await login(' VERIFIED@EXAMPLE.TEST ').expect(200);
    expect(Object.keys(response.body).sort()).toEqual(['accessToken', 'expiresIn', 'tokenType']);
    expect(response.body.expiresIn).toBe(900); expect(response.body.tokenType).toBe('Bearer');
    const user = await connection.db!.collection('usuarios').findOne({ correo: 'verified@example.test' });
    const decoded = jwt.verify(response.body.accessToken, Buffer.from(settings.JWT_ACCESS_SECRET_BASE64, 'base64'), { algorithms: ['HS256'], issuer: settings.JWT_ACCESS_ISSUER, audience: settings.JWT_ACCESS_AUDIENCE }) as jwt.JwtPayload;
    expect(decoded.sub).toBe(user!._id.toString()); expect(decoded.iss).toBe(settings.JWT_ACCESS_ISSUER); expect(decoded.aud).toBe(settings.JWT_ACCESS_AUDIENCE);
    expect(decoded.jti).toEqual(expect.any(String)); expect(decoded.exp! - decoded.iat!).toBe(900);
    for (const options of [{ issuer: 'wrong' }, { audience: 'wrong' }, { clockTimestamp: decoded.exp! + 1 }]) expect(() => jwt.verify(response.body.accessToken, Buffer.from(settings.JWT_ACCESS_SECRET_BASE64, 'base64'), { algorithms: ['HS256'], issuer: settings.JWT_ACCESS_ISSUER, audience: settings.JWT_ACCESS_AUDIENCE, ...options })).toThrow();
    const cookie = response.headers['set-cookie'][0] as string;
    const refresh = /^lethics_refresh=([^;]+)/.exec(cookie)![1];
    expect(refresh).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict');
    const session = await connection.db!.collection('sesiones').findOne({ usuarioId: user!._id });
    expect(new OpaqueTokenService().verify('refresh', refresh, session!.refreshTokenHash)).toBe(true);
    expect(session!.expiraEn.getTime() - session!.creadaEn.getTime()).toBe(604800000); expect(session!.revocadaEn).toBeNull(); expect(session!.familia).toEqual(expect.any(String));
    expect(Object.keys(session!).sort()).toEqual(['_id', 'usuarioId', 'refreshTokenHash', 'creadaEn', 'expiraEn', 'revocadaEn', 'familia'].sort());
    for (const secret of [password, hash, refresh, session!.refreshTokenHash, settings.JWT_ACCESS_SECRET_BASE64, settings.RATE_LIMIT_HMAC_KEY_BASE64]) expect(response.text + logs.join('\n')).not.toContain(secret);
    expect(JSON.stringify(session)).not.toContain(response.body.accessToken); expect(JSON.stringify(session)).not.toContain(refresh);
    expect(logs.join('\n')).not.toContain(response.body.accessToken);
    const hydrated = await connection.model<Sesion>('Sesion').findById(session!._id).select('+refreshTokenHash');
    expect(hydrated!.toJSON()).not.toHaveProperty('refreshTokenHash');
  });
  it.each([
    ['verified@example.test', 'wrong-password'], ['missing@example.test', password], ['unverified@example.test', password], ['restricted@example.test', password], ['invalid-hash@example.test', password],
  ])('deniega con el mismo 401 y sin crear sesión: %s', async (correo, contraseña) => {
    const before = await connection.db!.collection('sesiones').countDocuments();
    const result = await login(correo, contraseña).expect(401);
    expect(result.body.message).toBe('Credenciales no válidas.'); expect(result.headers['set-cookie']).toBeUndefined();
    expect(result.text).not.toContain(correo); expect(result.text).not.toContain(contraseña);
    expect(await connection.db!.collection('sesiones').countDocuments()).toBe(before);
  });
  it('admite logins concurrentes con sesiones, familias, refresh y jti distintos', async () => {
    const before = await connection.db!.collection('sesiones').countDocuments();
    const results = await Promise.all(Array.from({ length: 6 }, () => login()));
    expect(results.map((result) => result.status)).toEqual(Array(6).fill(200));
    expect(await connection.db!.collection('sesiones').countDocuments()).toBe(before + 6);
    const tokens = results.map((result) => (jwt.decode(result.body.accessToken) as jwt.JwtPayload).jti);
    expect(new Set(tokens).size).toBe(6);
    expect(new Set(results.map((result) => result.headers['set-cookie'][0].split(';')[0])).size).toBe(6);
    const sessions = await connection.db!.collection('sesiones').find().toArray();
    expect(new Set(sessions.map((session) => session.familia)).size).toBe(sessions.length);
  }, 15000);
  it('aplica cuota Redis real por origen en un namespace propio', async () => {
    const config = app.get(ConfigService), oldNamespace = config.get('RATE_LIMIT_NAMESPACE');
    config.set('RATE_LIMIT_NAMESPACE', createRedisTestTarget(redis!.uri).namespace); config.set('RATE_LIMIT_LOGIN_MAX', 1);
    try {
      await login('missing@example.test').expect(401);
      const blocked = await login().expect(429); expect(blocked.headers['set-cookie']).toBeUndefined();
    } finally { config.set('RATE_LIMIT_NAMESPACE', oldNamespace); config.set('RATE_LIMIT_LOGIN_MAX', 100); }
  });
  it('no emite credenciales si falla Redis o la escritura transaccional de sesión', async () => {
    const before = await connection.db!.collection('sesiones').countDocuments();
    const limiter = jest.spyOn(app.get(OriginRateLimitService), 'consume').mockRejectedValueOnce(new RateLimitUnavailableError());
    try { const result = await login().expect(503); expect(result.headers['set-cookie']).toBeUndefined(); } finally { limiter.mockRestore(); }
    const model = connection.model<Sesion>('Sesion');
    const insert = jest.spyOn(model, 'create').mockRejectedValueOnce(new Error('synthetic-private-database-error'));
    try {
      const result = await login().expect(503); expect(result.headers['set-cookie']).toBeUndefined(); expect(result.text).not.toMatch(/synthetic-private|accessToken|refresh/);
    } finally { insert.mockRestore(); }
    expect(await connection.db!.collection('sesiones').countDocuments()).toBe(before);
    expect(logs.join('\n')).not.toContain('synthetic-private-database-error');
  });
});
