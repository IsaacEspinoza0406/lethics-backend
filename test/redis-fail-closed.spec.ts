import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';
import { OriginRateLimitService, RateLimitUnavailableError } from '../src/infrastructure/rate-limit/origin-rate-limit.service';

jest.mock('redis', () => ({ createClient: jest.fn() }));

describe('Redis falla cerrado sin consumir cuotas en estados inciertos', () => {
  const run = 'a'.repeat(40);
  const server = `run_id:${run}\r\nuptime_in_seconds:3600\r\n`;
  const persistence = 'loading:0\r\naof_enabled:1\r\naof_last_write_status:ok\r\naof_last_bgrewrite_status:ok\r\n';
  const config = new ConfigService({ REDIS_URL: 'redis://:test-only@localhost:6380', RATE_LIMIT_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), RATE_LIMIT_NAMESPACE: 'unit', RATE_LIMIT_VERIFY_MAX: 60, RATE_LIMIT_VERIFY_WINDOW_SECONDS: 600, RATE_LIMIT_REGISTER_MAX: 20, RATE_LIMIT_REGISTER_WINDOW_SECONDS: 3600, RATE_LIMIT_RESEND_MAX: 20, RATE_LIMIT_RESEND_WINDOW_SECONDS: 3600 });
  function setup() {
    const client = { isReady: true, isOpen: true, on: jest.fn(), info: jest.fn(async (section: string) => section === 'server' ? server : section === 'persistence' ? persistence : 'role:master\r\n'), sendCommand: jest.fn().mockResolvedValue(['appendonly', 'yes', 'appendfsync', 'always', 'maxmemory-policy', 'noeviction']), eval: jest.fn().mockResolvedValue([1, 600]), close: jest.fn() };
    (createClient as jest.Mock).mockReturnValue(client);
    return { client, service: new OriginRateLimitService(config) };
  }
  it('rechaza cuarentena antes de EVAL', async () => {
    const { client, service } = setup();
    client.info.mockImplementation(async (section: string) => section === 'server' ? server.replace('3600', '3599') : section === 'persistence' ? persistence : 'role:master\r\n');
    await expect(service.consume('verify', '192.0.2.1', false)).rejects.toBeInstanceOf(RateLimitUnavailableError);
    expect(client.eval).not.toHaveBeenCalled();
  });
  it('rechaza CONFIG denegado antes de EVAL', async () => {
    const { client, service } = setup();
    client.sendCommand.mockRejectedValue(new Error('ACL denied'));
    await expect(service.consume('verify', '192.0.2.1', false)).rejects.toBeInstanceOf(RateLimitUnavailableError);
    expect(client.eval).not.toHaveBeenCalled();
  });
  it('rechaza fallo de escritura y cambio de proceso durante EVAL', async () => {
    const { client, service } = setup();
    client.eval.mockRejectedValueOnce(new Error('write failed'));
    await expect(service.consume('verify', '192.0.2.1', false)).rejects.toBeInstanceOf(RateLimitUnavailableError);
    client.eval.mockImplementationOnce(async () => { client.info.mockResolvedValue(server.replace(run, 'b'.repeat(40))); return [1, 600]; });
    await expect(service.consume('verify', '192.0.2.1', false)).rejects.toBeInstanceOf(RateLimitUnavailableError);
  });
  it('conserva la cuota y cierra la conexión', async () => {
    const { client, service } = setup();
    client.eval.mockResolvedValue([61, 500]);
    expect(await service.consume('verify', '192.0.2.1', false)).toEqual({ allowed: false, retryAfterSeconds: 500 });
    await service.onApplicationShutdown();
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
