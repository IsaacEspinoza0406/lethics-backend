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
import { UsersModule } from '../src/modules/users/users.module';
import { AccessTokenService } from '../src/infrastructure/security/access-token.service';
import { AuthenticatedIdentityService } from '../src/modules/identity/application/authenticated-identity.service';
import { PasswordService } from '../src/infrastructure/security/password.service';
import { OpaqueTokenService } from '../src/infrastructure/security/opaque-token.service';
import { OriginRateLimitService, RateLimitUnavailableError } from '../src/infrastructure/rate-limit/origin-rate-limit.service';
import { Sesion } from '../src/modules/identity/infrastructure/schemas/identity.schemas';
import { installIdentityIndexes } from '../src/modules/identity/infrastructure/identity-indexes';
import { optionalMongoTestScope, optionalRedisTestTarget, createRedisTestTarget } from './integration-isolation';

const scope = optionalMongoTestScope(process.env.LETHICS_IDENTITY_TEST_URI, 'identity');
const redis = optionalRedisTestTarget(process.env.LETHICS_REDIS_TEST_URL);
(scope && redis ? describe : describe.skip)('Rotación/revocación HTTP con MongoDB/Redis propios', () => {
  let app: INestApplication, connection: Connection;
  const origin = 'http://localhost:3000', password = 'synthetic-password', opaque = new OpaqueTokenService();
  const logs: string[] = [], spies: jest.SpyInstance[] = [];
  const settings = { NODE_ENV: 'test', AUTH_HTTP_ENABLED: true, AUTH_BEHIND_PROXY: false, AUTH_BROWSER_ORIGIN: origin, AUTH_REFRESH_TTL_SECONDS: 604800, AUTH_REFRESH_COOKIE_SECURE: false,
    VERIFICATION_ACCOUNT_FAILURES_PER_HOUR: 20, VERIFICATION_ACCOUNT_EMISSIONS_PER_HOUR: 5,
    JWT_ACCESS_SECRET_BASE64: randomBytes(32).toString('base64'), JWT_ACCESS_ISSUER: 'sessions-test', JWT_ACCESS_AUDIENCE: 'sessions-test', JWT_ACCESS_TTL_SECONDS: 900,
    VERIFICATION_CODE_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), RATE_LIMIT_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), REDIS_URL: redis?.uri, RATE_LIMIT_NAMESPACE: redis?.namespace,
    RATE_LIMIT_LOGIN_MAX: 200, RATE_LIMIT_LOGIN_WINDOW_SECONDS: 600, RATE_LIMIT_REFRESH_MAX: 100, RATE_LIMIT_REFRESH_WINDOW_SECONDS: 600, RATE_LIMIT_LOGOUT_MAX: 100, RATE_LIMIT_LOGOUT_WINDOW_SECONDS: 600,
    RATE_LIMIT_VERIFY_MAX: 60, RATE_LIMIT_VERIFY_WINDOW_SECONDS: 600, RATE_LIMIT_REGISTER_MAX: 20, RATE_LIMIT_REGISTER_WINDOW_SECONDS: 3600, RATE_LIMIT_RESEND_MAX: 20, RATE_LIMIT_RESEND_WINDOW_SECONDS: 3600,
  };
  @Global()
  @Module({ providers: [{ provide: getConnectionToken(), useFactory: () => connection }], exports: [getConnectionToken()] })
  class TemporaryConnectionModule {}

  beforeAll(async () => {
    for (const level of ['log', 'error', 'warn', 'debug', 'verbose'] as const) spies.push(jest.spyOn(Logger.prototype, level).mockImplementation((...values: unknown[]) => { logs.push(values.map(String).join(' ')); }));
    const temporary = await scope!.open(); connection = mongoose.createConnection().setClient(temporary.client);
    for (const name of ['usuarios', 'tokens_cuenta', 'sesiones']) await temporary.db.createCollection(name);
    await installIdentityIndexes(temporary.db, `INSTALL INDEXES ${scope!.dbName}`);
    await temporary.db.collection('usuarios').insertOne({ correo: 'student@example.test', nombre: 'Estudiante', contraseñaHash: await new PasswordService().hash(password), rol: 'estudiante', verificadoEn: new Date() });
    const module = await Test.createTestingModule({ imports: [TemporaryConnectionModule, ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => settings] }), AuthHttpModule, UsersModule] }).compile();
    app = module.createNestApplication(); configureApp(app); await app.init();
  }, 20000);
  afterAll(async () => {
    try { if (app) await app.close(); } finally { try { await scope?.close(); } finally { try { if (connection) await connection.close(); } finally { for (const spy of spies) spy.mockRestore(); } } }
  });
  const pair = (response: request.Response): string => response.headers['set-cookie'][0].split(';')[0];
  const hash = (cookie: string) => opaque.digest('refresh', cookie.slice('lethics_refresh='.length));
  const records = () => connection.db!.collection('sesiones');
  const record = (cookie: string) => records().findOne({ refreshTokenHash: hash(cookie) });
  const start = () => request(app.getHttpServer()).post('/api/v1/auth/login').send({ correo: 'student@example.test', contraseña: password }).expect(200);
  const command = (operation: 'refresh' | 'logout', cookie?: string) => {
    const call = request(app.getHttpServer()).post(`/api/v1/auth/${operation}`).set('Origin', origin);
    if (cookie) call.set('Cookie', cookie);
    return call.send({});
  };

  it('users/me exige Bearer, limita perfil propio y conserva garantía real después de logout', async () => {
    const login = await start(), token = login.body.accessToken;
    await request(app.getHttpServer()).get('/api/v1/users/me').expect(401);
    const me = await request(app.getHttpServer()).get('/api/v1/users/me').auth(token, { type: 'bearer' }).query({ usuarioId: '000000000000000000000099', rol: 'otro' }).expect(200);
    expect(me.body).toEqual({ id: expect.any(String), correo: 'student@example.test', nombre: 'Estudiante', rol: 'estudiante' });
    expect(Object.keys(me.body).sort()).toEqual(['correo', 'id', 'nombre', 'rol']); expect(me.headers['cache-control']).toBe('no-store');
    expect(me.text + logs.join('\n')).not.toContain(password); expect(logs.join('\n')).not.toContain(token);
    await command('logout', pair(login)).expect(204);
    await command('refresh', pair(login)).expect(401);
    await request(app.getHttpServer()).get('/api/v1/users/me').auth(token, { type: 'bearer' }).expect(200);
  });
  it.each(['missing', 'unverified', 'partial', 'null-security', 'future-verification', 'role'] as const)('rechaza identidad persistida incompatible: %s', async (state) => {
    const user = { correo: `${state}@example.test`, nombre: 'Sintético', rol: 'estudiante', verificadoEn: new Date(), contraseñaHash: 'synthetic-private-hash', perfil: { secret: 'synthetic-private-profile' } };
    const inserted = await connection.db!.collection('usuarios').insertOne(user);
    const collection = connection.db!.collection('usuarios');
    if (state === 'missing') await collection.deleteOne({ _id: inserted.insertedId });
    else await collection.updateOne({ _id: inserted.insertedId }, { $set: state === 'unverified' ? { verificadoEn: null } : state === 'partial' ? { seguridadVerificacion: { fallos: 0 } } : state === 'null-security' ? { seguridadVerificacion: null } : state === 'future-verification' ? { verificadoEn: new Date(Date.now() + 60000) } : { rol: 'valor-no-aprobado' } });
    const token = app.get(AccessTokenService).sign(inserted.insertedId.toHexString());
    const result = await request(app.getHttpServer()).get('/api/v1/users/me').auth(token, { type: 'bearer' }).expect(state === 'role' ? 403 : 401);
    expect(result.text).not.toMatch(/synthetic-private|contraseña|seguridadVerificacion|perfil/);
  });
  it('perfil utiliza proyección explícita y no expone datos secretos de documentos lean', async () => {
    const result = await connection.db!.collection('usuarios').insertOne({ nombre: 'Perfil', correo: 'profile@example.test', rol: 'estudiante', verificadoEn: new Date(), contraseñaHash: 'synthetic-private-hash', perfil: { secret: 'synthetic-private-profile' } });
    const token = app.get(AccessTokenService).sign(result.insertedId.toHexString());
    const response = await request(app.getHttpServer()).get('/api/v1/users/me').auth(token, { type: 'bearer' }).expect(200);
    expect(Object.keys(response.body).sort()).toEqual(['correo', 'id', 'nombre', 'rol']); expect(response.text).not.toMatch(/synthetic-private|contraseña|perfil|verificadoEn/);
    await request(app.getHttpServer()).get('/api/v1/users/me').auth(app.get(AccessTokenService).sign('invalid-subject'), { type: 'bearer' }).expect(401);
  });
  it('consulta MongoDB fallida no habilita el perfil ni filtra errores', async () => {
    const login = await start(), spy = jest.spyOn(app.get(AuthenticatedIdentityService), 'findEligibleProfile').mockRejectedValueOnce(new Error('synthetic-private-lookup'));
    try { const result = await request(app.getHttpServer()).get('/api/v1/users/me').auth(login.body.accessToken, { type: 'bearer' }).expect(503); expect(result.text + logs.join('\n')).not.toContain('synthetic-private-lookup'); } finally { spy.mockRestore(); }
  });
  it('fallo de MongoDB entre guard y perfil también devuelve 503 sanitizado', async () => {
    const login = await start(), model = connection.model('Usuario'), original = model.findById.bind(model);
    const spy = jest.spyOn(model, 'findById').mockImplementationOnce(original).mockImplementationOnce(() => { throw new Error('synthetic-private-profile-query'); });
    try { const result = await request(app.getHttpServer()).get('/api/v1/users/me').auth(login.body.accessToken, { type: 'bearer' }).expect(503); expect(result.text + logs.join('\n')).not.toContain('synthetic-private-profile-query'); } finally { spy.mockRestore(); }
  });

  it('rota sin extender expiración, conserva historial y solo expone access en JSON', async () => {
    const login = await start(), oldCookie = pair(login), before = (await record(oldCookie))!;
    const result = await command('refresh', oldCookie).expect(200), newCookie = pair(result);
    expect(newCookie).not.toBe(oldCookie);
    expect(Object.keys(result.body).sort()).toEqual(['accessToken', 'expiresIn', 'tokenType']);
    const next = (await record(newCookie))!, old = (await record(oldCookie))!;
    expect(old.revocadaEn).toBeInstanceOf(Date); expect(next.revocadaEn).toBeNull();
    expect(next.familia).toBe(before.familia); expect(next.usuarioId).toEqual(before.usuarioId); expect(next.expiraEn).toEqual(before.expiraEn);
    expect(next.refreshTokenHash).not.toBe(old.refreshTokenHash); expect(await records().countDocuments({ familia: before.familia })).toBe(2);
    const claims = jwt.verify(result.body.accessToken, Buffer.from(settings.JWT_ACCESS_SECRET_BASE64, 'base64'), { algorithms: ['HS256'], issuer: settings.JWT_ACCESS_ISSUER, audience: settings.JWT_ACCESS_AUDIENCE }) as jwt.JwtPayload;
    expect(claims.sub).toBe(before.usuarioId.toString()); expect(claims.exp! - claims.iat!).toBe(900); expect(claims.jti).not.toBe((jwt.decode(login.body.accessToken) as jwt.JwtPayload).jti);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['set-cookie'][0]).toContain('HttpOnly'); expect(result.headers['set-cookie'][0]).toContain('SameSite=Strict');
    expect(result.headers['set-cookie'][0]).toContain('Path=/api/v1/auth');
    for (const secret of [oldCookie.split('=')[1], newCookie.split('=')[1], next.refreshTokenHash, password, settings.JWT_ACCESS_SECRET_BASE64]) expect(result.text + logs.join('\n')).not.toContain(secret);
    expect(logs.join('\n')).not.toContain(result.body.accessToken);
    expect(JSON.stringify(next)).not.toContain(newCookie.split('=')[1]); expect(JSON.stringify(next)).not.toContain(result.body.accessToken);
  });
  it('demuestra reutilización del ancestro y revoca toda su familia, conservando otra independiente', async () => {
    const root = pair(await start()), independent = pair(await start());
    const second = pair(await command('refresh', root).expect(200));
    const third = pair(await command('refresh', second).expect(200));
    const family = (await record(root))!.familia;
    const replay = await command('refresh', root).expect(401);
    expect(replay.body.message).toBe('Sesión no válida.'); expect(replay.headers['set-cookie'][0]).toContain('Expires=Thu, 01 Jan 1970');
    expect(await records().countDocuments({ familia: family, revocadaEn: null })).toBe(0);
    await command('refresh', third).expect(401);
    await command('refresh', independent).expect(200);
  });
  it.each(['expired', 'revoked', 'missing-family', 'invalid-revocation'] as const)('rechaza estado no renovable: %s', async (state) => {
    const cookie = pair(await start()), current = (await record(cookie))!;
    const update = state === 'expired' ? { expiraEn: new Date(Date.now() - 1) } : state === 'revoked' ? { revocadaEn: new Date() } : state === 'missing-family' ? { familia: null } : { revocadaEn: 'invalid-date' };
    await records().updateOne({ _id: current._id }, { $set: update });
    await command('refresh', cookie).expect(401);
    expect(await records().countDocuments({ refreshTokenHash: current.refreshTokenHash })).toBe(1);
    if (state !== 'missing-family') expect(await records().countDocuments({ familia: current.familia })).toBe(1);
    await command('logout', cookie).expect(204);
  });
  it('rechaza token manipulado, ausente, duplicado y token en body sin revocar una familia válida', async () => {
    const cookie = pair(await start()), current = (await record(cookie))!;
    for (const value of [undefined, 'lethics_refresh=invalid', `lethics_refresh=${opaque.generate()}`, `${cookie}; ${cookie}`]) await command('refresh', value).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').set('Origin', origin).send({ refreshToken: cookie.split('=')[1] }).expect(401);
    expect((await records().findOne({ _id: current._id }))!.revocadaEn).toBeNull();
  });
  it('dos refresh concurrentes consumen una sola vez; el perdedor revoca la familia', async () => {
    const cookie = pair(await start()), family = (await record(cookie))!.familia;
    const results = await Promise.all([command('refresh', cookie), command('refresh', cookie)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 401]);
    expect(await records().countDocuments({ familia: family })).toBe(2);
    expect(await records().countDocuments({ familia: family, revocadaEn: null })).toBe(0);
    await command('refresh', pair(results.find((result) => result.status === 200)!)).expect(401);
  });
  it('logout revoca servidor y cookie, es repetible y no afecta otra sesión', async () => {
    const cookie = pair(await start()), independent = pair(await start());
    const next = pair(await command('refresh', cookie).expect(200));
    const result = await command('logout', next).expect(204);
    expect(result.text).toBe(''); expect(result.headers['set-cookie'][0]).toContain('Expires=Thu, 01 Jan 1970');
    expect(result.headers['set-cookie'][0]).toContain('HttpOnly'); expect(result.headers['set-cookie'][0]).toContain('SameSite=Strict');
    await command('logout', next).expect(204); await command('logout', cookie).expect(204); await command('logout').expect(204);
    await command('refresh', next).expect(401); await command('refresh', independent).expect(200);
  });
  it('logout usando el ancestro revoca también el sucesor vigente', async () => {
    const root = pair(await start()), next = pair(await command('refresh', root).expect(200));
    await command('logout', root).expect(204);
    await command('refresh', next).expect(401);
  });
  it('refresh y logout concurrentes nunca dejan un sucesor renovable', async () => {
    const cookie = pair(await start()), family = (await record(cookie))!.familia;
    const [refresh, logout] = await Promise.all([command('refresh', cookie), command('logout', cookie)]);
    expect([200, 401]).toContain(refresh.status); expect(logout.status).toBe(204);
    expect(await records().countDocuments({ familia: family, revocadaEn: null })).toBe(0);
  });
  it.each(['refresh', 'logout'] as const)('%s falla cerrado ante Redis y protege Origin/JSON', async (operation) => {
    const cookie = pair(await start()), before = await record(cookie);
    const spy = jest.spyOn(app.get(OriginRateLimitService), 'consume').mockRejectedValueOnce(new RateLimitUnavailableError());
    try { const failed = await command(operation, cookie).expect(503); expect(failed.headers['set-cookie']).toBeUndefined(); } finally { spy.mockRestore(); }
    await request(app.getHttpServer()).post(`/api/v1/auth/${operation}`).set('Cookie', cookie).send({}).expect(403);
    await request(app.getHttpServer()).post(`/api/v1/auth/${operation}`).set('Origin', 'http://attacker.example.test').set('Cookie', cookie).send({}).expect(403);
    await request(app.getHttpServer()).post(`/api/v1/auth/${operation}`).set('Origin', origin).set('Sec-Fetch-Site', 'cross-site').set('Cookie', cookie).send({}).expect(403);
    await request(app.getHttpServer()).post(`/api/v1/auth/${operation}`).set('Origin', origin).set('Cookie', cookie).type('form').send({}).expect(415);
    expect(await record(cookie)).toEqual(before);
  });
  it('un fallo al insertar el sucesor revierte el consumo anterior y no emite cookie', async () => {
    const cookie = pair(await start()), before = (await record(cookie))!;
    const spy = jest.spyOn(connection.model<Sesion>('Sesion'), 'create').mockRejectedValueOnce(new Error('synthetic-private-db-error'));
    try {
      const result = await command('refresh', cookie).expect(503); expect(result.headers['set-cookie']).toBeUndefined(); expect(result.text).not.toMatch(/synthetic-private|accessToken|refreshToken/);
    } finally { spy.mockRestore(); }
    expect((await record(cookie))!.revocadaEn).toBeNull(); expect(await records().countDocuments({ familia: before.familia })).toBe(1);
    await command('refresh', cookie).expect(200); expect(logs.join('\n')).not.toContain('synthetic-private-db-error');
  });
  it('un fallo en revocación de familia no se presenta como 401 ni logout confirmado', async () => {
    const root = pair(await start()), child = pair(await command('refresh', root).expect(200));
    const model = connection.model<Sesion>('Sesion');
    for (const operation of ['refresh', 'logout'] as const) {
      const spy = jest.spyOn(model, 'updateMany').mockRejectedValueOnce(new Error('synthetic-private-revocation-error'));
      try { const result = await command(operation, root).expect(503); expect(result.headers['set-cookie']).toBeUndefined(); } finally { spy.mockRestore(); }
      expect((await record(child))!.revocadaEn).toBeNull();
    }
    await command('refresh', root).expect(401); expect((await record(child))!.revocadaEn).toBeInstanceOf(Date);
  });
  it('reutilización y rotación del sucesor concurrentes no permiten escapar a la revocación', async () => {
    const root = pair(await start()), child = pair(await command('refresh', root).expect(200)), family = (await record(root))!.familia;
    const [replay, rotation] = await Promise.all([command('refresh', root), command('refresh', child)]);
    expect(replay.status).toBe(401); expect([200, 401]).toContain(rotation.status);
    expect(await records().countDocuments({ familia: family, revocadaEn: null })).toBe(0);
  });
  it('aplica cuotas Redis reales independientes para refresh y logout', async () => {
    const config = app.get(ConfigService), namespace = config.get('RATE_LIMIT_NAMESPACE');
    config.set('RATE_LIMIT_NAMESPACE', createRedisTestTarget(redis!.uri).namespace); config.set('RATE_LIMIT_REFRESH_MAX', 1); config.set('RATE_LIMIT_LOGOUT_MAX', 1);
    try {
      await command('refresh').expect(401); await command('refresh').expect(429);
      await command('logout').expect(204); await command('logout').expect(429);
    } finally { config.set('RATE_LIMIT_NAMESPACE', namespace); config.set('RATE_LIMIT_REFRESH_MAX', 100); config.set('RATE_LIMIT_LOGOUT_MAX', 100); }
  });
});
