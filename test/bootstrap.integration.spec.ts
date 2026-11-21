import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { environmentSchema } from '../src/config/environment';
import { configureApp } from '../src/configure-app';
import { SecurityModule } from '../src/infrastructure/security/security.module';
import { PasswordService } from '../src/infrastructure/security/password.service';
import { AccessTokenService } from '../src/infrastructure/security/access-token.service';
import { OpaqueTokenService } from '../src/infrastructure/security/opaque-token.service';
import { HealthController } from '../src/modules/health/health.controller';
import { getConnectionToken } from '@nestjs/mongoose';
import { createRedisTestTarget, optionalMongoTestScope } from './integration-isolation';

describe('Configuración e inyección de seguridad', () => {
  it('resuelve los tres servicios y aplica la configuración HTTP compartida', async () => {
    const secret = randomBytes(32).toString('base64');
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ JWT_ACCESS_SECRET_BASE64: secret, JWT_ACCESS_ISSUER: 'test', JWT_ACCESS_AUDIENCE: 'test', JWT_ACCESS_TTL_SECONDS: 60 })] }), SecurityModule],
      controllers: [HealthController],
      providers: [{ provide: getConnectionToken(), useValue: { readyState: 1, db: { admin: () => ({ ping: async () => ({ ok: 1 }) }) } } }],
    }).compile();
    const app = module.createNestApplication();
    configureApp(app);
    await app.init();
    try {
      expect(app.get(PasswordService)).toBeInstanceOf(PasswordService);
      expect(app.get(AccessTokenService)).toBeInstanceOf(AccessTokenService);
      expect(app.get(OpaqueTokenService)).toBeInstanceOf(OpaqueTokenService);
      for (const path of ['/api/v1/health', '/api/v1/inexistente', '/docs-json']) {
        const response = await request(app.getHttpServer()).get(path);
        expect(response.text.includes(secret)).toBe(false);
      }
    } finally { await app.close(); }
  });
});

const scope = optionalMongoTestScope(process.env.LETHICS_IDENTITY_TEST_URI, 'bootstrap');
const uri = scope?.uri;
const integration = scope ? describe : describe.skip;
integration('Arranque real compilado', () => {
  beforeAll(async () => {
    await scope!.open();
  });
  afterAll(async () => {
    await scope!.close();
  });
  const secret = randomBytes(32).toString('base64');
  const cwd = resolve(process.cwd(), 'node_modules'); // No carga el .env del proyecto.
  const main = resolve(process.cwd(), 'dist/main.js');
  const testNamespace = createRedisTestTarget('redis://:test-only@localhost:6380').namespace;
  const base: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', MONGODB_URI: uri, JWT_ACCESS_SECRET_BASE64: secret, JWT_ACCESS_ISSUER: 'test-issuer', JWT_ACCESS_AUDIENCE: 'test-audience', JWT_ACCESS_TTL_SECONDS: '60', VERIFICATION_CODE_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), RATE_LIMIT_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), REDIS_URL: 'redis://:test-only@localhost:6380' };

  it('rechaza configuración ausente o inválida sin divulgar la clave', () => {
    for (const field of ['JWT_ACCESS_SECRET_BASE64', 'JWT_ACCESS_ISSUER', 'JWT_ACCESS_AUDIENCE', 'JWT_ACCESS_TTL_SECONDS', 'VERIFICATION_CODE_HMAC_KEY_BASE64', 'RATE_LIMIT_HMAC_KEY_BASE64', 'REDIS_URL']) {
      const env: NodeJS.ProcessEnv = { ...base, RATE_LIMIT_NAMESPACE: testNamespace };
      delete env[field];
      const child = spawnSync(process.execPath, [main], { cwd, env, encoding: 'utf8', timeout: 10000 });
      expect(child.status).not.toBe(0);
      expect(child.error).toBeUndefined();
      expect(child.stderr + child.stdout).toContain(field);
      expect(child.stderr + child.stdout).toContain('Config validation error');
      expect((child.stderr + child.stdout).includes(secret)).toBe(false);
    }
    for (const override of [{ JWT_ACCESS_SECRET_BASE64: 'clave-invalida' }, { JWT_ACCESS_TTL_SECONDS: '0' }]) {
      const child = spawnSync(process.execPath, [main], { cwd, env: { ...base, RATE_LIMIT_NAMESPACE: testNamespace, ...override }, encoding: 'utf8', timeout: 10000 });
      expect(child.status).not.toBe(0);
      expect(child.error).toBeUndefined();
      expect(child.stderr + child.stdout).toContain('Config validation error');
      expect((child.stderr + child.stdout).includes(secret)).toBe(false);
      expect(child.stderr + child.stdout).not.toContain('clave-invalida');
    }
  }, 90000);

  it('inicia Nest contra MongoDB y no filtra la clave en HTTP ni Swagger', async () => {
    const server = createServer();
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Puerto no disponible');
    const port = address.port;
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    const child = spawn(process.execPath, [main], { cwd, env: { ...base, RATE_LIMIT_NAMESPACE: testNamespace, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    try {
      let health: Response | undefined;
      for (let attempt = 0; attempt < 50; attempt++) {
        if (child.exitCode !== null) throw new Error('El proceso terminó antes de estar disponible');
        try { health = await fetch(`http://127.0.0.1:${port}/api/v1/health`); break; } catch { await new Promise((done) => setTimeout(done, 200)); }
      }
      expect(health?.status).toBe(200);
      expect(await health?.json()).toEqual({ api: 'up', mongodb: 'up' });
      for (const path of ['/api/v1/health', '/api/v1/inexistente', '/docs', '/docs-json']) {
        const body = await (await fetch(`http://127.0.0.1:${port}${path}`)).text();
        expect(body.includes(secret)).toBe(false);
        expect(body).not.toContain('test-issuer');
        expect(body).not.toContain('test-audience');
      }
      expect(output.includes(secret)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((done) => child.once('close', () => done()));
        child.kill();
        await closed;
      }
    }
  }, 20000);
});

describe('Esquema de variables JWT', () => {
  it('rechaza clave débil sin incluirla en el mensaje', () => {
    const weak = Buffer.alloc(32).toString('base64');
    const result = environmentSchema.validate({ MONGODB_URI: 'mongodb://localhost/test', JWT_ACCESS_SECRET_BASE64: weak, JWT_ACCESS_ISSUER: 'test', JWT_ACCESS_AUDIENCE: 'test', JWT_ACCESS_TTL_SECONDS: 60 });
    expect(result.error).toBeDefined();
    expect(result.error?.message).not.toContain(weak);
  });
});
