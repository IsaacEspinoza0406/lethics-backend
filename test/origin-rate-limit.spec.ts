import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { OriginRateLimitService, RateLimitUnavailableError, resolveDirectOrigin } from '../src/infrastructure/rate-limit/origin-rate-limit.service';

describe('Origen y fallo cerrado', () => {
  it('normaliza IPv4, IPv6 y IPv4 mapeada y rechaza proxy o direcciones inválidas', () => {
    expect(resolveDirectOrigin('192.0.2.1', false)).toBe('192.0.2.1');
    expect(resolveDirectOrigin('2001:0db8:0:0::1', false)).toBe('2001:db8::1');
    expect(resolveDirectOrigin('::ffff:192.0.2.1', false)).toBe('192.0.2.1');
    expect(() => resolveDirectOrigin('192.0.2.1', true)).toThrow(RateLimitUnavailableError);
    expect(() => resolveDirectOrigin('127.0.0.1, 192.0.2.1', false)).toThrow(RateLimitUnavailableError);
    expect(() => resolveDirectOrigin(undefined, false)).toThrow(RateLimitUnavailableError);
  });
  it('falla cerrado si falta configuración y si Redis no está disponible', async () => {
    const missing = new OriginRateLimitService(new ConfigService({}));
    await expect(missing.consume('verify', '127.0.0.1', false)).rejects.toBeInstanceOf(RateLimitUnavailableError);
    const unavailable = new OriginRateLimitService(new ConfigService({ REDIS_URL: 'redis://:not-a-real-secret@127.0.0.1:1', RATE_LIMIT_HMAC_KEY_BASE64: randomBytes(32).toString('base64') }));
    await expect(unavailable.consume('verify', '127.0.0.1', false)).rejects.toBeInstanceOf(RateLimitUnavailableError);
    await unavailable.onApplicationShutdown();
  });
});
