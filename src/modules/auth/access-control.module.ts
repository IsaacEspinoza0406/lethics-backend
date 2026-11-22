import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { SecurityModule } from '../../infrastructure/security/security.module';
import { IdentityModule } from '../identity/identity.module';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';

@Module({
  imports: [SecurityModule, IdentityModule],
  providers: [JwtAuthGuard, RolesGuard, { provide: APP_GUARD, useExisting: JwtAuthGuard }, { provide: APP_GUARD, useExisting: RolesGuard }],
  exports: [JwtAuthGuard, RolesGuard],
})
export class AccessControlModule {}
