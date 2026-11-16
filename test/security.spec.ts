import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { PasswordService } from '../src/infrastructure/security/password.service';
import { AccessTokenService } from '../src/infrastructure/security/access-token.service';
import { OpaqueTokenService } from '../src/infrastructure/security/opaque-token.service';

describe('Infraestructura de seguridad', () => {
  it('usa Argon2id con sal distinta y rechaza contraseñas y hashes inválidos', async () => {
    const service = new PasswordService();
    const first = await service.hash('ejemplo');
    const second = await service.hash('ejemplo');
    expect(first).toMatch(/^\$argon2id\$/);
    expect(first).not.toBe(second);
    expect(await service.verify(first, 'ejemplo')).toBe(true);
    expect(await service.verify(first, 'incorrecta')).toBe(false);
    expect(await service.verify('inválido', 'ejemplo')).toBe(false);
    expect(await service.verify(first, '')).toBe(false);
    await expect(service.hash('')).rejects.toThrow();
  });

  describe('JWT', () => {
    const key = randomBytes(32);
    const config = new ConfigService({ JWT_ACCESS_SECRET_BASE64: key.toString('base64'), JWT_ACCESS_ISSUER: 'issuer-test', JWT_ACCESS_AUDIENCE: 'audience-test', JWT_ACCESS_TTL_SECONDS: 60 });
    const service = new AccessTokenService(config);
    const options: jwt.SignOptions = { algorithm: 'HS256', issuer: 'issuer-test', audience: 'audience-test', subject: 'id-test', jwtid: 'jti-test' };
    it('firma y valida subject, iat, jti y expiración', () => {
      expect(service.verify(service.sign('id-test'))).toMatchObject({ sub: 'id-test', jti: expect.any(String), iat: expect.any(Number), exp: expect.any(Number) });
      expect(() => service.sign(' ')).toThrow();
    });
    it('rechaza firma, vencimiento, issuer, audience y algoritmo incorrectos', () => {
      const cases = [
        jwt.sign({}, randomBytes(32), { ...options, expiresIn: 60 }),
        jwt.sign({}, key, { ...options, expiresIn: -1 }),
        jwt.sign({}, key, { ...options, issuer: 'otro', expiresIn: 60 }),
        jwt.sign({}, key, { ...options, audience: 'otro', expiresIn: 60 }),
        jwt.sign({}, key, { ...options, algorithm: 'HS384', expiresIn: 60 }),
        jwt.sign({}, key, { algorithm: 'HS256', issuer: 'issuer-test', audience: 'audience-test', expiresIn: 60 }),
      ];
      for (const token of cases) expect(() => service.verify(token)).toThrow();
    });
    it('rechaza tokens sin exp o iat y fechas incoherentes', () => {
      expect(() => service.verify(jwt.sign({}, key, options))).toThrow();
      expect(() => service.verify(jwt.sign({ exp: Math.floor(Date.now() / 1000) + 60 }, key, { ...options, noTimestamp: true }))).toThrow();
      expect(() => service.verify(jwt.sign({ iat: Math.floor(Date.now() / 1000) + 100, exp: Math.floor(Date.now() / 1000) + 200 }, key, options))).toThrow();
    });
  });

  it('genera 32 bytes y separa los hashes por propósito', () => {
    const service = new OpaqueTokenService();
    const first = service.generate();
    const second = service.generate();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first, 'base64url')).toHaveLength(32);
    expect(first).not.toBe(second);
    const hash = service.digest('account', first);
    expect(service.verify('account', first, hash)).toBe(true);
    expect(service.verify('refresh', first, hash)).toBe(false);
    expect(service.verify('account', second, hash)).toBe(false);
    expect(service.verify('account', first, 'invalid')).toBe(false);
    expect(() => service.digest('account', 'invalid')).toThrow();
  });
});
