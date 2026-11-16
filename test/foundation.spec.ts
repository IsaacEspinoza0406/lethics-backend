import { Controller, Get, INestApplication, ServiceUnavailableException } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { environmentSchema } from '../src/config/environment';
import { configureApp } from '../src/configure-app';
import { HealthController } from '../src/modules/health/health.controller';
import { randomBytes } from 'node:crypto';

@Controller('independent')
class IndependentController {
  @Get()
  fail(): never { throw new ServiceUnavailableException('unrelated'); }
}

describe('Fundamentos', () => {
  it('valida la configuración requerida y los puertos', () => {
    const security = { JWT_ACCESS_SECRET_BASE64: randomBytes(32).toString('base64'), JWT_ACCESS_ISSUER: 'test', JWT_ACCESS_AUDIENCE: 'test', JWT_ACCESS_TTL_SECONDS: 900, VERIFICATION_CODE_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), RATE_LIMIT_HMAC_KEY_BASE64: randomBytes(32).toString('base64'), REDIS_URL: 'redis://:test-only@localhost:6380' };
    expect(environmentSchema.validate({}).error).toBeDefined();
    expect(environmentSchema.validate({ ...security, MONGODB_URI: 'mongodb://localhost/test', PORT: 70000 }).error).toBeDefined();
    expect(environmentSchema.validate({ ...security, MONGODB_URI: 'mongodb://localhost/test', PORT: 3000 }).error).toBeUndefined();
    expect(environmentSchema.validate({ ...security, JWT_ACCESS_SECRET_BASE64: Buffer.alloc(32).toString('base64'), MONGODB_URI: 'mongodb://localhost/test' }).error).toBeDefined();
    expect(environmentSchema.validate({ ...security, VERIFICATION_CODE_HMAC_KEY_BASE64: security.JWT_ACCESS_SECRET_BASE64, MONGODB_URI: 'mongodb://localhost/test' }).error).toBeDefined();
    expect(environmentSchema.validate({ ...security, RATE_LIMIT_HMAC_KEY_BASE64: security.VERIFICATION_CODE_HMAC_KEY_BASE64, MONGODB_URI: 'mongodb://localhost/test' }).error).toBeDefined();
    expect(environmentSchema.validate({ ...security, REDIS_URL: 'redis://localhost:6380', MONGODB_URI: 'mongodb://localhost/test' }).error).toBeDefined();
  });

  describe('HTTP health', () => {
    let app: INestApplication;
    const ping = jest.fn(async () => ({ ok: 1 }));
    const connection = { readyState: 1, db: { admin: () => ({ ping }) } };

    beforeAll(async () => {
      const module = await Test.createTestingModule({
        controllers: [HealthController, IndependentController],
        providers: [{ provide: getConnectionToken(), useValue: connection }],
      }).compile();
      app = module.createNestApplication();
      configureApp(app);
      await app.init();
    });
    afterAll(async () => app.close());

    it('inicia y responde con ambos servicios disponibles', async () => {
      await request(app.getHttpServer()).get('/api/v1/health').expect(200).expect({ api: 'up', mongodb: 'up' });
    });
    it('distingue la caída de MongoDB', async () => {
      connection.readyState = 0;
      const response = await request(app.getHttpServer()).get('/api/v1/health').expect(503);
      expect(response.body).toMatchObject({ api: 'up', mongodb: 'down', message: 'MongoDB no disponible' });
      connection.readyState = 1;
    });
    it('oculta detalles cuando falla el ping', async () => {
      ping.mockRejectedValueOnce(new Error('secret connection string'));
      const response = await request(app.getHttpServer()).get('/api/v1/health').expect(503);
      expect(response.body).toMatchObject({ api: 'up', mongodb: 'down' });
      expect(JSON.stringify(response.body)).not.toContain('secret');
    });
    it('no atribuye otros errores HTTP a MongoDB', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/independent').expect(503);
      expect(response.body).not.toHaveProperty('mongodb');
      expect(response.body.message).toBe('Error interno del servidor');
      const missing = await request(app.getHttpServer()).get('/api/v1/missing').expect(404);
      expect(missing.body).not.toHaveProperty('mongodb');
    });
  });
});
