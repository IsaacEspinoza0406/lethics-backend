import { Controller, Get, INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import request from 'supertest';
import { AccessTokenService } from '../src/infrastructure/security/access-token.service';
import { AuthenticatedIdentityService } from '../src/modules/identity/application/authenticated-identity.service';
import { JwtAuthGuard } from '../src/modules/auth/jwt-auth.guard';
import { RolesGuard } from '../src/modules/auth/roles.guard';
import { AUTHENTICATED_USER, AuthenticatedRequest, Public, Roles } from '../src/modules/auth/access-control';
import { configureApp } from '../src/configure-app';

@Controller('access-test')
@Roles('estudiante')
class ProtectedController {
  @Get('private') privateRoute() { return { protected: true }; }
  @Get('public') @Public() publicRoute() { return { public: true }; }
  @Get('denied') @Roles() denied() { return {}; }
}
@Public()
@Controller('public-test')
class PublicController {
  @Get() open() { return {}; }
  @Get('private') @Public(false) privateRoute() { return {}; }
}

describe('Autenticación Bearer y autorización HTTP reutilizables', () => {
  let app: INestApplication, tokens: AccessTokenService;
  const id = '000000000000000000000001', secret = randomBytes(32), issuer = 'access-test', audience = 'access-test';
  const profile = { id, rol: 'estudiante', nombre: 'Estudiante', correo: 'student@example.test' };
  const identities = { findEligibleProfile: jest.fn() };
  beforeAll(async () => {
    tokens = new AccessTokenService(new ConfigService({ JWT_ACCESS_SECRET_BASE64: secret.toString('base64'), JWT_ACCESS_ISSUER: issuer, JWT_ACCESS_AUDIENCE: audience, JWT_ACCESS_TTL_SECONDS: 900 }));
    const module = await Test.createTestingModule({ controllers: [ProtectedController, PublicController], providers: [Reflector,
      { provide: AccessTokenService, useValue: tokens }, { provide: AuthenticatedIdentityService, useValue: identities },
      { provide: APP_GUARD, useClass: JwtAuthGuard }, { provide: APP_GUARD, useClass: RolesGuard },
    ] }).compile();
    app = module.createNestApplication(); configureApp(app); await app.init();
  });
  beforeEach(() => { identities.findEligibleProfile.mockReset().mockResolvedValue(profile); });
  afterAll(async () => { await app.close(); });
  const get = (header?: string) => {
    const call = request(app.getHttpServer()).get('/api/v1/access-test/private');
    return header === undefined ? call : call.set('Authorization', header);
  };
  const signed = (payload: jwt.JwtPayload = {}, options: jwt.SignOptions = {}) => jwt.sign({ sub: id, jti: 'synthetic-id', ...payload }, secret, { algorithm: 'HS256', issuer, audience, expiresIn: 900, ...options });

  it('acepta JWT válido y consulta identidad exclusivamente por sub', async () => {
    await get(`Bearer ${tokens.sign(id)}`).expect(200, { protected: true });
    expect(identities.findEligibleProfile).toHaveBeenCalledWith(id);
  });
  it.each([
    ['expirado', () => signed({}, { expiresIn: -1 })],
    ['manipulado', () => `${signed().split('.').slice(0, 2).join('.')}.${Buffer.alloc(32).toString('base64url')}`],
    ['algoritmo', () => signed({}, { algorithm: 'HS384' })],
    ['issuer', () => signed({}, { issuer: 'incorrect' })],
    ['audience', () => signed({}, { audience: 'incorrect' })],
    ['sin sub', () => signed({ sub: '' })],
    ['sin jti', () => signed({ jti: '' })],
    ['sin iat', () => signed({}, { noTimestamp: true })],
    ['sin exp', () => jwt.sign({ sub: id, jti: 'id' }, secret, { issuer, audience, algorithm: 'HS256' })],
    ['iat futuro', () => signed({ iat: Math.floor(Date.now() / 1000) + 60 })],
  ] as const)('rechaza JWT %s sin consultar MongoDB', async (_label, create) => {
    const result = await get(`Bearer ${create()}`).expect(401);
    expect(result.body.message).toBe('Autenticación no válida.'); expect(identities.findEligibleProfile).not.toHaveBeenCalled();
    expect(result.text).not.toMatch(/stack|JsonWebTokenError|secret|signature/);
  });
  it.each([undefined, '', 'Bearer', 'Basic abc', 'Bearer a.b.c extra', 'Bearer  a.b.c', 'Bearer a.b.c, Bearer a.b.c'])('rechaza Authorization mal formado: %s', async (header) => {
    await get(header).expect(401); expect(identities.findEligibleProfile).not.toHaveBeenCalled();
  });
  it('ignora access tokens en cookie, query y cabeceras alternativas', async () => {
    const token = tokens.sign(id);
    await request(app.getHttpServer()).get('/api/v1/access-test/private').query({ access_token: token }).set('Cookie', `accessToken=${token}`).set('X-Access-Token', token).expect(401);
  });
  it('rechaza identidad no elegible con 401', async () => { identities.findEligibleProfile.mockResolvedValue(null); await get(`Bearer ${tokens.sign(id)}`).expect(401); });
  it('rechaza rol persistido no aprobado con 403 aunque cliente afirme estudiante', async () => {
    identities.findEligibleProfile.mockResolvedValue({ ...profile, rol: 'valor-no-aprobado' });
    await get(`Bearer ${signed({ rol: 'estudiante' })}`).query({ rol: 'estudiante' }).expect(403);
  });
  it('metadata sin roles permitidos deniega con 403', async () => { await request(app.getHttpServer()).get('/api/v1/access-test/denied').auth(tokens.sign(id), { type: 'bearer' }).expect(403); });
  it('rutas públicas no consultan identidad, incluso con Bearer inválido', async () => {
    await request(app.getHttpServer()).get('/api/v1/access-test/public').set('Authorization', 'Bearer invalid').expect(200);
    await request(app.getHttpServer()).get('/api/v1/public-test').expect(200);
    expect(identities.findEligibleProfile).not.toHaveBeenCalled();
  });
  it('Public(false) exige autenticación dentro de controlador público', async () => {
    await request(app.getHttpServer()).get('/api/v1/public-test/private').expect(401);
    await request(app.getHttpServer()).get('/api/v1/public-test/private').auth(tokens.sign(id), { type: 'bearer' }).expect(200);
  });
  it('expone contexto mínimo inmutable construido desde MongoDB', async () => {
    const req = { headers: { authorization: `Bearer ${tokens.sign(id)}` }, rawHeaders: [] } as unknown as AuthenticatedRequest;
    const context = { getHandler: () => ProtectedController.prototype.privateRoute, getClass: () => ProtectedController, switchToHttp: () => ({ getRequest: () => req }) };
    await new JwtAuthGuard(new Reflector(), tokens, identities as unknown as AuthenticatedIdentityService).canActivate(context as never);
    expect(req[AUTHENTICATED_USER]).toEqual({ id, rol: 'estudiante' }); expect(Object.isFrozen(req[AUTHENTICATED_USER])).toBe(true);
  });
  it('roles sin identidad autenticada falla cerrado', () => {
    const guard = new RolesGuard(new Reflector());
    const context = { getHandler: () => ProtectedController.prototype.privateRoute, getClass: () => ProtectedController, switchToHttp: () => ({ getRequest: () => ({}) }) };
    expect(() => guard.canActivate(context as never)).toThrow('Autenticación no válida.');
  });
  it('rechaza Authorization duplicado y elimina contexto previo', async () => {
    const req = { headers: { authorization: `Bearer ${tokens.sign(id)}` }, rawHeaders: ['Authorization', 'one', 'authorization', 'two'], [AUTHENTICATED_USER]: profile } as unknown as AuthenticatedRequest;
    const context = { getHandler: () => ProtectedController.prototype.privateRoute, getClass: () => ProtectedController, switchToHttp: () => ({ getRequest: () => req }) };
    await expect(new JwtAuthGuard(new Reflector(), tokens, identities as unknown as AuthenticatedIdentityService).canActivate(context as never)).rejects.toThrow('Autenticación no válida.');
    expect(req[AUTHENTICATED_USER]).toBeUndefined();
  });
  it('infraestructura no disponible falla cerrado con error sanitizado', async () => {
    identities.findEligibleProfile.mockRejectedValue(new ServiceUnavailableException('synthetic-private-error'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try { const result = await get(`Bearer ${tokens.sign(id)}`).expect(503); expect(result.text).not.toContain('synthetic-private-error'); } finally { spy.mockRestore(); }
  });
});
