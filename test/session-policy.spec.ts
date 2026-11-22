import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { Connection, Model, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { OpaqueTokenService } from '../src/infrastructure/security/opaque-token.service';
import { AccessTokenService } from '../src/infrastructure/security/access-token.service';
import { AuthController } from '../src/modules/auth/auth.controller';
import { IdentityOperationsService } from '../src/modules/identity/application/identity-operations.service';
import { SessionDeniedError, SessionService } from '../src/modules/identity/application/session.service';
import { Sesion, Usuario } from '../src/modules/identity/infrastructure/schemas/identity.schemas';
import { assertSessionRequest, readRefreshCookie } from '../src/modules/auth/login-http.policy';

describe('Política de cookie y resultado de sesiones', () => {
  const opaque = new OpaqueTokenService(), token = opaque.generate();
  const config = new ConfigService({ NODE_ENV: 'production', AUTH_BROWSER_ORIGIN: 'https://app.example.test', JWT_ACCESS_TTL_SECONDS: 900 });
  const req = (cookie?: string, origin: string | undefined = 'https://app.example.test', site?: string, json = true) => ({ headers: { cookie, origin, 'sec-fetch-site': site }, socket: { remoteAddress: '127.0.0.1' }, is: () => json ? 'application/json' : false }) as unknown as Request;
  it('lee una única cookie canónica e ignora otras sin aceptar token desde el cuerpo', () => {
    expect(readRefreshCookie(req(`other=x; lethics_refresh=${token}; another=y`))).toBe(token);
    expect(readRefreshCookie({ ...req(), body: { refreshToken: token } } as Request)).toBeUndefined();
  });
  it.each(['', 'short', '%41'.repeat(43), 'a'.repeat(44), 'a'.repeat(42) + '!'])('rechaza valor no canónico: %s', (value) => {
    expect(readRefreshCookie(req(`lethics_refresh=${value}`))).toBeUndefined();
  });
  it('rechaza cookies duplicadas y ausencia', () => {
    expect(readRefreshCookie(req(`lethics_refresh=${token}; lethics_refresh=${token}`))).toBeUndefined();
    expect(readRefreshCookie(req())).toBeUndefined();
  });
  it('exige Origin, JSON y ausencia de cross-site incluso con cookie válida', () => {
    expect(() => assertSessionRequest(req(undefined), config)).not.toThrow();
    for (const value of [req(undefined, ''), req(undefined, 'https://other.example.test'), req(undefined, 'https://app.example.test', 'cross-site'), req(undefined, 'https://app.example.test', undefined, false)]) expect(() => assertSessionRequest(value, config)).toThrow();
  });
  it('refresh devuelve solo acceso y cookie segura; un 401 elimina cookie, un 503 no afirma revocación', async () => {
    const operations = { refresh: jest.fn().mockResolvedValue({ accessToken: 'synthetic-access', expiresIn: 900, refreshToken: token, refreshExpiresAt: new Date(Date.now() + 10000) }) };
    const controller = new AuthController(operations as unknown as IdentityOperationsService, config);
    const response = { cookie: jest.fn(), clearCookie: jest.fn(), setHeader: jest.fn() };
    expect(await controller.refresh(req(`lethics_refresh=${token}`), response as unknown as Response)).toEqual({ accessToken: 'synthetic-access', tokenType: 'Bearer', expiresIn: 900 });
    expect(response.cookie).toHaveBeenCalledWith('lethics_refresh', token, expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'strict', path: '/api/v1/auth' }));
    operations.refresh.mockRejectedValueOnce(new SessionDeniedError());
    await expect(controller.refresh(req(), response as unknown as Response)).rejects.toMatchObject({ status: 401 });
    expect(response.clearCookie).toHaveBeenCalledTimes(1);
    operations.refresh.mockRejectedValueOnce(new Error('private database error'));
    await expect(controller.refresh(req(), response as unknown as Response)).rejects.toMatchObject({ status: 503 });
    expect(response.clearCookie).toHaveBeenCalledTimes(1);
  });
  it('confirma revocación transaccional antes de devolver denegación por reutilización', async () => {
    const userId = new Types.ObjectId(), family = randomUUID();
    const current = { _id: new Types.ObjectId(), usuarioId: userId, familia: family, expiraEn: new Date(Date.now() + 10000), revocadaEn: new Date() };
    let committed = false;
    const transaction = { endSession: jest.fn(), withTransaction: jest.fn(async (run: () => Promise<unknown>) => { const value = await run(); committed = true; return value; }) };
    const connection = { db: { listCollections: () => ({ toArray: async () => [{ name: 'sesiones' }] }) }, startSession: async () => transaction };
    const sessions = { find: () => ({ limit: () => ({ session: () => ({ lean: async () => [current] }) }) }), updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }) };
    const service = new SessionService(connection as unknown as Connection, {} as Model<Usuario>, sessions as unknown as Model<Sesion>, {} as AccessTokenService, opaque, config);
    await expect(service.refresh(token)).rejects.toBeInstanceOf(SessionDeniedError);
    expect(committed).toBe(true);
    expect(sessions.updateMany).toHaveBeenCalledWith({ usuarioId: userId, familia: family, revocadaEn: null }, { $set: { revocadaEn: expect.any(Date) } }, { session: transaction });
    expect(transaction.endSession).toHaveBeenCalledTimes(1);
  });
});
