import { Module } from '@nestjs/common';
import { AccessTokenService } from './access-token.service';
import { OpaqueTokenService } from './opaque-token.service';
import { PasswordService } from './password.service';

@Module({ providers: [PasswordService, AccessTokenService, OpaqueTokenService], exports: [PasswordService, AccessTokenService, OpaqueTokenService] })
export class SecurityModule {}
