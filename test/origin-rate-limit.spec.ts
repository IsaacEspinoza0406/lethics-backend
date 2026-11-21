import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { OriginRateLimitService, RateLimitUnavailableError, resolveDirectOrigin } from '../src/infrastructure/rate-limit/origin-rate-limit.service';
import { Controller, Get, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Request } from 'express';
import request from 'supertest';

@Controller('socket-test')
class SocketTestController {
  @Get()
  origin(@Req() req: Request) { return { origin: resolveDirectOrigin(req.socket.remoteAddress, false) }; }
}

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
  it.each(['127.000.0.1', '192.0.2.1:3000', '[2001:db8::1]', 'fe80::1%eth0', 'for=192.0.2.1', 'unknown', ''])('rechaza origen ambiguo %s', (origin) => {
    expect(() => resolveDirectOrigin(origin, false)).toThrow(RateLimitUnavailableError);
  });
  it('unifica IPv6 equivalente y IPv4 mapeada hexadecimal', () => {
    expect(resolveDirectOrigin('2001:0DB8:0000:0000:0000:0000:0000:0001', false)).toBe('2001:db8::1');
    expect(resolveDirectOrigin('::ffff:c000:201', false)).toBe('192.0.2.1');
  });
  it('mantiene el socket ante cabeceras manipuladas en una solicitud HTTP real de prueba', async () => {
    const module = await Test.createTestingModule({ controllers: [SocketTestController] }).compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      const response = await request(app.getHttpServer()).get('/socket-test')
        .set('X-Forwarded-For', '192.0.2.1, 198.51.100.1').set('Forwarded', 'for="[2001:db8::1]";proto=https').set('X-Real-IP', '203.0.113.1').expect(200);
      expect(response.body.origin).toBe('127.0.0.1');
    } finally { await app.close(); }
  });
});
