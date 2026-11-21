import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { createClient } from 'redis';
import { inspectRedisReadiness } from './redis-readiness';

export type LimitedOperation = 'register' | 'verify' | 'resend';
export class RateLimitUnavailableError extends Error { constructor() { super('Control de solicitudes no disponible'); } }

/** Only the direct socket address is accepted. Proxy deployments must remain blocked. */
export function resolveDirectOrigin(address: string | undefined, behindProxy: boolean): string {
  if (behindProxy || !address || address.includes('%') || !isIP(address)) throw new RateLimitUnavailableError();
  if (isIP(address) === 4) return address;
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

const SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then return redis.error_reply('invalid counter expiry') end
return {n, ttl}
`;

@Injectable()
export class OriginRateLimitService implements OnApplicationShutdown {
  private client?: ReturnType<typeof createClient>;
  private connecting?: Promise<void>;
  constructor(private readonly config: ConfigService) {}

  private async getClient(): Promise<ReturnType<typeof createClient>> {
    const url = this.config.get<string>('REDIS_URL');
    const key = this.config.get<string>('RATE_LIMIT_HMAC_KEY_BASE64');
    if (!url || !key) throw new RateLimitUnavailableError();
    const bytes = Buffer.from(key, 'base64');
    if (bytes.length !== 32 || bytes.toString('base64') !== key || new Set(bytes).size < 16 || key === this.config.get('JWT_ACCESS_SECRET_BASE64') || key === this.config.get('VERIFICATION_CODE_HMAC_KEY_BASE64')) throw new RateLimitUnavailableError();
    const parsed = new URL(url);
    if (!parsed.password || (this.config.get('NODE_ENV') === 'production' && (parsed.protocol !== 'rediss:' || this.config.get('RATE_LIMIT_NAMESPACE') === 'development'))) throw new RateLimitUnavailableError();
    if (!this.client) {
      this.client = createClient({ url, socket: { connectTimeout: 2000, reconnectStrategy: false }, disableOfflineQueue: true });
      this.client.on('error', () => undefined);
    }
    if (!this.client.isReady) {
      if (!this.connecting && !this.client.isOpen) this.connecting = this.client.connect().then(() => undefined).finally(() => { this.connecting = undefined; });
      if (!this.connecting) throw new RateLimitUnavailableError();
      await this.connecting;
    }
    return this.client;
  }

  async consume(operation: LimitedOperation, socketAddress: string | undefined, behindProxy: boolean): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    try {
      if (!['register', 'verify', 'resend'].includes(operation)) throw new Error('invalid operation');
      if (typeof behindProxy !== 'boolean') throw new RateLimitUnavailableError();
      const origin = resolveDirectOrigin(socketAddress, behindProxy);
      const client = await this.getClient();
      const caps = { register: 'REGISTER', verify: 'VERIFY', resend: 'RESEND' } as const;
      const window = this.config.getOrThrow<number>(`RATE_LIMIT_${caps[operation]}_WINDOW_SECONDS`);
      const max = this.config.getOrThrow<number>(`RATE_LIMIT_${caps[operation]}_MAX`);
      const maxWindow = Math.max(...Object.values(caps).map((v) => this.config.getOrThrow<number>(`RATE_LIMIT_${v}_WINDOW_SECONDS`)));
      const before = await client.info('server');
      const persistence = await client.info('persistence');
      const replication = await client.info('replication');
      const settings = await client.sendCommand(['CONFIG', 'GET', 'appendonly', 'appendfsync', 'maxmemory-policy']);
      const readiness = inspectRedisReadiness(before, persistence, replication, settings, maxWindow);
      const runId = readiness.runId;
      if (!readiness.ready || !Number.isSafeInteger(max) || max < 1 || !Number.isSafeInteger(window) || window < 1) throw new Error('untrusted state');
      const digest = createHmac('sha256', Buffer.from(this.config.getOrThrow<string>('RATE_LIMIT_HMAC_KEY_BASE64'), 'base64')).update(origin).digest('hex');
      const name = `lethics:limit:${this.config.getOrThrow<string>('RATE_LIMIT_NAMESPACE')}:${operation}:${digest}`;
      const result = await client.eval(SCRIPT, { keys: [name], arguments: [String(window)] });
      const after = await client.info('server');
      if (!new RegExp(`^run_id:${runId}\\r?$`, 'm').test(after) || !Array.isArray(result) || typeof result[0] !== 'number' || typeof result[1] !== 'number') throw new Error('invalid state');
      return { allowed: result[0] <= max, retryAfterSeconds: result[0] <= max ? 0 : Math.max(1, result[1]) };
    } catch { throw new RateLimitUnavailableError(); }
  }

  async onApplicationShutdown(): Promise<void> { if (this.client?.isOpen) await this.client.close(); }
}
