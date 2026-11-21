import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { AuthController } from './auth.controller';
import { AuthHttpGuard } from './auth-http.guard';
import { AuthHttpPolicy } from './auth-http.policy';

@Module({ imports: [IdentityModule], controllers: [AuthController], providers: [AuthHttpGuard, AuthHttpPolicy], exports: [AuthHttpPolicy] })
export class AuthHttpModule {}
