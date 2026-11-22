import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { environmentSchema } from './config/environment';
import { HealthModule } from './modules/health/health.module';
import { SecurityModule } from './infrastructure/security/security.module';
import { RateLimitModule } from './infrastructure/rate-limit/rate-limit.module';
import { IdentityModule } from './modules/identity/identity.module';
import { AuthHttpModule } from './modules/auth/auth-http.module';
import { UsersModule } from './modules/users/users.module';
import { AssessmentsModule } from './modules/assessments/assessments.module';
import { LearningModule } from './modules/learning/learning.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validationSchema: environmentSchema }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ uri: config.getOrThrow<string>('MONGODB_URI'), serverSelectionTimeoutMS: 5000, retryAttempts: 3, retryDelay: 1000 }),
    }),
    HealthModule,
    SecurityModule,
    RateLimitModule,
    IdentityModule,
    AuthHttpModule,
    UsersModule,
    AssessmentsModule,
    LearningModule,
  ],
})
export class AppModule {}
