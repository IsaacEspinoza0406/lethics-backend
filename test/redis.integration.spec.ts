import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { OriginRateLimitService } from '../src/infrastructure/rate-limit/origin-rate-limit.service';
import { optionalRedisTestTarget } from './integration-isolation';

const target = optionalRedisTestTarget(process.env.LETHICS_REDIS_TEST_URL);
(target ? describe : describe.skip)('Redis aislado', () => {
  it('comparte cuota entre instancias, separa operaciones y expira la ventana', async () => {
    const config = new ConfigService({ REDIS_URL: target!.uri, RATE_LIMIT_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), RATE_LIMIT_NAMESPACE: target!.namespace, RATE_LIMIT_VERIFY_MAX: 2, RATE_LIMIT_VERIFY_WINDOW_SECONDS: 2, RATE_LIMIT_REGISTER_MAX: 2, RATE_LIMIT_REGISTER_WINDOW_SECONDS: 2, RATE_LIMIT_RESEND_MAX: 2, RATE_LIMIT_RESEND_WINDOW_SECONDS: 2 });
    const a = new OriginRateLimitService(config), b = new OriginRateLimitService(config);
    try {
      const results = await Promise.all([a.consume('verify', '192.0.2.2', false), b.consume('verify', '192.0.2.2', false), a.consume('verify', '192.0.2.2', false)]);
      expect(results.filter((r) => r.allowed)).toHaveLength(2);
      expect((await b.consume('register', '192.0.2.2', false)).allowed).toBe(true);
      expect((await b.consume('resend', '192.0.2.2', false)).allowed).toBe(true);
      await a.onApplicationShutdown();
      const restarted = new OriginRateLimitService(config);
      try { expect((await restarted.consume('verify', '192.0.2.2', false)).allowed).toBe(false); } finally { await restarted.onApplicationShutdown(); }
      await new Promise((done) => setTimeout(done, 2200));
      expect((await b.consume('verify', '192.0.2.2', false)).allowed).toBe(true);
    } finally { await a.onApplicationShutdown(); await b.onApplicationShutdown(); }
  }, 20000);
});
