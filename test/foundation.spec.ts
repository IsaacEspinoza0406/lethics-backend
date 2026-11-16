import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { environmentSchema } from '../src/config/environment';
import { HttpExceptionFilter } from '../src/common/http-exception.filter';
import { HealthController } from '../src/modules/health/health.controller';

describe('Fundamentos', () => {
  it('valida la configuración requerida y los puertos', () => {
    expect(environmentSchema.validate({}).error).toBeDefined();
    expect(environmentSchema.validate({ MONGODB_URI: 'mongodb://localhost/test', PORT: 70000 }).error).toBeDefined();
    expect(environmentSchema.validate({ MONGODB_URI: 'mongodb://localhost/test', PORT: 3000 }).error).toBeUndefined();
  });

  describe('HTTP health', () => {
    let app: INestApplication;
    const connection = { readyState: 1, db: { admin: () => ({ ping: async () => ({ ok: 1 }) }) } };

    beforeAll(async () => {
      const module = await Test.createTestingModule({
        controllers: [HealthController],
        providers: [{ provide: getConnectionToken(), useValue: connection }],
      }).compile();
      app = module.createNestApplication();
      app.setGlobalPrefix('api/v1');
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
      app.useGlobalFilters(new HttpExceptionFilter());
      await app.init();
    });
    afterAll(async () => app.close());

    it('inicia y responde con ambos servicios disponibles', async () => {
      await request(app.getHttpServer()).get('/api/v1/health').expect(200).expect({ api: 'up', mongodb: 'up' });
    });
    it('distingue la caída de MongoDB', async () => {
      connection.readyState = 0;
      const response = await request(app.getHttpServer()).get('/api/v1/health').expect(503);
      expect(response.body).toMatchObject({ api: 'up', mongodb: 'down', message: 'Error interno del servidor' });
      connection.readyState = 1;
    });
  });
});
