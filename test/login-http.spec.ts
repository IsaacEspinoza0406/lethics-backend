import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { configureApp } from '../src/configure-app';
import { AuthController } from '../src/modules/auth/auth.controller';
import { AuthHttpGuard } from '../src/modules/auth/auth-http.guard';
import { AuthHttpPolicy } from '../src/modules/auth/auth-http.policy';
import { IdentityOperationsService } from '../src/modules/identity/application/identity-operations.service';
import { RegistrationService } from '../src/modules/identity/application/registration.service';
import { VerifyEmailService } from '../src/modules/identity/application/verify-email.service';
import { ResendVerificationService } from '../src/modules/identity/application/resend-verification.service';
import { LoginService, LoginDeniedError } from '../src/modules/identity/application/login.service';
import { VERIFICATION_MAILER } from '../src/modules/identity/application/verification-mailer';
import { TestVerificationMailer } from '../src/modules/identity/infrastructure/test-verification-mailer';
import { OriginRateLimitService, RateLimitUnavailableError } from '../src/infrastructure/rate-limit/origin-rate-limit.service';
import { refreshCookieOptions } from '../src/modules/auth/login-http.policy';
import { environmentSchema } from '../src/config/environment';

describe('Contrato HTTP de login', () => {
  let app: INestApplication;
  const limiter = { consume: jest.fn() }, login = { login: jest.fn() };
  const collections = jest.fn();
  async function setup(overrides: Record<string, unknown> = {}) {
    const config = new ConfigService({ NODE_ENV: 'test', AUTH_HTTP_ENABLED: true, AUTH_BEHIND_PROXY: false, AUTH_BROWSER_ORIGIN: 'http://localhost:3000', ...overrides });
    const operations = new IdentityOperationsService(limiter as unknown as OriginRateLimitService, {} as RegistrationService, {} as VerifyEmailService, {} as ResendVerificationService, login as unknown as LoginService);
    const module = await Test.createTestingModule({ controllers: [AuthController], providers: [AuthHttpGuard, AuthHttpPolicy,
      { provide: ConfigService, useValue: config }, { provide: IdentityOperationsService, useValue: operations },
      { provide: VERIFICATION_MAILER, useValue: new TestVerificationMailer() },
      { provide: getConnectionToken(), useValue: { readyState: 1, db: {
        collection: (name: string) => ({ listIndexes: () => ({ toArray: async () => [{ name: name === 'usuarios' ? 'correo_1' : 'tokenHash_1', key: { [name === 'usuarios' ? 'correo' : 'tokenHash']: 1 }, unique: true }] }) }),
        listCollections: () => ({ toArray: collections }),
      } } },
    ] }).compile();
    app = module.createNestApplication(); configureApp(app); await app.init();
  }
  beforeEach(() => {
    jest.clearAllMocks(); limiter.consume.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }); collections.mockResolvedValue([{ name: 'sesiones' }]);
    login.login.mockResolvedValue({ accessToken: 'synthetic-access', expiresIn: 900, refreshToken: 'synthetic-refresh', refreshExpiresAt: new Date(Date.now() + 604800000) });
  });
  afterEach(async () => { if (app) await app.close(); });
  const input = { correo: ' STUDENT@EXAMPLE.TEST ', contraseña: ' synthetic password ' };

  it('normaliza solo correo, aplica una cuota del socket e impide serializar refresh', async () => {
    await setup();
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://localhost:3000').set('X-Forwarded-For', '192.0.2.55').send(input).expect(200);
    expect(response.body).toEqual({ accessToken: 'synthetic-access', tokenType: 'Bearer', expiresIn: 900 });
    expect(response.text).not.toMatch(/refresh|password|contraseña|hash/);
    expect(login.login).toHaveBeenCalledWith({ correo: 'student@example.test', contraseña: input.contraseña });
    expect(limiter.consume).toHaveBeenCalledTimes(1); expect(limiter.consume.mock.calls[0][0]).toBe('login');
    expect(limiter.consume.mock.calls[0][1]).not.toBe('192.0.2.55');
    expect(response.headers['cache-control']).toBe('no-store');
    const cookie = response.headers['set-cookie'][0] as string;
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict'); expect(cookie).toContain('Path=/api/v1/auth'); expect(cookie).not.toContain('Domain=');
    expect(cookie).not.toContain('Secure');
    const docs = await request(app.getHttpServer()).get('/docs-json').expect(200);
    expect(docs.body.paths['/api/v1/auth/login']).toBeDefined();
    expect(docs.body.paths['/api/v1/auth/register']).toBeUndefined();
  });
  it.each([{ rol: 'admin' }, { usuarioId: 'x' }, { correo: { $ne: null } }, { contraseña: 123 }, { contraseña: '' }, { contraseña: 'a'.repeat(1025) }, { correo: 'invalid' }])('rechaza entrada inválida sin ejecutar login: %j', async (extra) => {
    await setup();
    await request(app.getHttpServer()).post('/api/v1/auth/login').send({ ...input, ...extra }).expect(400);
    expect(login.login).not.toHaveBeenCalled(); expect(limiter.consume).toHaveBeenCalledTimes(1);
  });
  it('devuelve el mismo 401 genérico y ninguna cookie ante denegación', async () => {
    await setup(); login.login.mockRejectedValue(new LoginDeniedError());
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send(input).expect(401);
    expect(response.body.message).toBe('Credenciales no válidas.'); expect(response.headers['set-cookie']).toBeUndefined();
  });
  it.each([false, true])('conserva bloqueo por activación/proxy: %s', async (proxy) => {
    await setup(proxy ? { AUTH_BEHIND_PROXY: true } : { AUTH_HTTP_ENABLED: false });
    await request(app.getHttpServer()).post('/api/v1/auth/login').send(input).expect(503);
    expect(limiter.consume).not.toHaveBeenCalled(); expect(login.login).not.toHaveBeenCalled();
    const docs = await request(app.getHttpServer()).get('/docs-json'); expect(docs.body.paths['/api/v1/auth/login']).toBeUndefined();
  });
  it('falla cerrado ante Redis, cuota o colección sesiones ausente', async () => {
    await setup(); limiter.consume.mockRejectedValueOnce(new RateLimitUnavailableError());
    await request(app.getHttpServer()).post('/api/v1/auth/login').send(input).expect(503);
    limiter.consume.mockResolvedValueOnce({ allowed: false });
    await request(app.getHttpServer()).post('/api/v1/auth/login').send(input).expect(429);
    collections.mockResolvedValueOnce([]);
    await request(app.getHttpServer()).post('/api/v1/auth/login').send(input).expect(503);
    expect(login.login).not.toHaveBeenCalled();
  });
  it('rechaza solicitudes de navegador no autorizadas y formularios', async () => {
    await setup();
    await request(app.getHttpServer()).post('/api/v1/auth/login').set('Origin', 'http://attacker.example.test').send(input).expect(403);
    await request(app.getHttpServer()).post('/api/v1/auth/login').set('Sec-Fetch-Site', 'cross-site').send(input).expect(403);
    await request(app.getHttpServer()).post('/api/v1/auth/login').type('form').send(input).expect(415);
    expect(login.login).not.toHaveBeenCalled();
  });
  it('emite Secure en producción y rechaza desactivarlo', async () => {
    await setup({ NODE_ENV: 'production' });
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send(input).expect(200);
    expect(response.headers['set-cookie'][0]).toContain('Secure');
    expect(() => refreshCookieOptions(new ConfigService({ NODE_ENV: 'production', AUTH_REFRESH_COOKIE_SECURE: false }))).toThrow();
  });
  it('valida duración corta, cookie y origen en configuración', () => {
    const base = { NODE_ENV: 'production', MONGODB_URI: 'mongodb://localhost/test', JWT_ACCESS_SECRET_BASE64: randomBytes(32).toString('base64'), JWT_ACCESS_ISSUER: 'test', JWT_ACCESS_AUDIENCE: 'test', JWT_ACCESS_TTL_SECONDS: 900, VERIFICATION_CODE_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), RATE_LIMIT_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), REDIS_URL: 'rediss://:synthetic@localhost:6380', RATE_LIMIT_NAMESPACE: 'synthetic' };
    const result = environmentSchema.validate(base); expect(result.error).toBeUndefined(); expect(result.value.AUTH_REFRESH_TTL_SECONDS).toBe(604800); expect(result.value.AUTH_REFRESH_COOKIE_SECURE).toBe(true);
    for (const override of [{ JWT_ACCESS_TTL_SECONDS: 901 }, { AUTH_REFRESH_TTL_SECONDS: 604801 }, { AUTH_REFRESH_COOKIE_SECURE: false }, { AUTH_BROWSER_ORIGIN: 'http://example.test' }, { AUTH_BROWSER_ORIGIN: '*' }]) expect(environmentSchema.validate({ ...base, ...override }).error).toBeDefined();
  });
});
