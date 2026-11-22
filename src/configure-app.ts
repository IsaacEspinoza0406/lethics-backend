import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { AuthHttpPolicy } from './modules/auth/auth-http.policy';

export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  const swagger = new DocumentBuilder().setTitle('Lethics API').setVersion('1').addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token').build();
  const document = SwaggerModule.createDocument(app, swagger);
  let policy: AuthHttpPolicy | undefined;
  try { policy = app.get(AuthHttpPolicy, { strict: false }); } catch { /* Apps without authentication expose no auth contracts. */ }
  for (const operation of ['register', 'verify', 'resend', 'login', 'refresh', 'logout'] as const) {
    if (!policy?.isEnabled(operation)) delete document.paths[`/api/v1/auth/${operation}`];
  }
  SwaggerModule.setup('docs', app, document);
}
