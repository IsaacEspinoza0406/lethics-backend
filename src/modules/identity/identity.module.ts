import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Connection, Model } from 'mongoose';
import { SesionSchema, TokenCuentaSchema, UsuarioSchema } from './infrastructure/schemas/identity.schemas';
import { TokenCuenta, Usuario, Sesion } from './infrastructure/schemas/identity.schemas';
import { SecurityModule } from '../../infrastructure/security/security.module';
import { PasswordService } from '../../infrastructure/security/password.service';
import { AccessTokenService } from '../../infrastructure/security/access-token.service';
import { OpaqueTokenService } from '../../infrastructure/security/opaque-token.service';
import { LoginService } from './application/login.service';
import { SessionService } from './application/session.service';
import { AuthenticatedIdentityService } from './application/authenticated-identity.service';
import { RegistrationService } from './application/registration.service';
import { VerifyEmailService } from './application/verify-email.service';
import { ResendVerificationService } from './application/resend-verification.service';
import { VERIFICATION_MAILER, VerificationMailer } from './application/verification-mailer';
import { verificationCodesFromConfig, verificationPolicyFromConfig, VerificationPolicy } from './application/verification-policy';
import { VerificationCodeService } from './infrastructure/verification-code.service';
import { verificationMailerFromConfig } from './infrastructure/verification-mailer.factory';
import { RateLimitModule } from '../../infrastructure/rate-limit/rate-limit.module';
import { OriginRateLimitService } from '../../infrastructure/rate-limit/origin-rate-limit.service';
import { IdentityOperationsService } from './application/identity-operations.service';

const POLICY = Symbol('VERIFICATION_POLICY');

@Module({
  imports: [SecurityModule, RateLimitModule, MongooseModule.forFeature([
    { name: 'Usuario', schema: UsuarioSchema },
    { name: 'TokenCuenta', schema: TokenCuentaSchema },
    { name: 'Sesion', schema: SesionSchema },
  ])],
  providers: [
    AuthenticatedIdentityService,
    { provide: VerificationCodeService, useFactory: verificationCodesFromConfig, inject: [ConfigService] },
    { provide: POLICY, useFactory: verificationPolicyFromConfig, inject: [ConfigService] },
    { provide: VERIFICATION_MAILER, useFactory: verificationMailerFromConfig, inject: [ConfigService] },
    { provide: RegistrationService, useFactory: (connection: Connection, users: Model<Usuario>, tokens: Model<TokenCuenta>, passwords: PasswordService, codes: VerificationCodeService, mailer: VerificationMailer) => new RegistrationService(connection, users, tokens, passwords, codes, mailer), inject: [getConnectionToken(), getModelToken('Usuario'), getModelToken('TokenCuenta'), PasswordService, VerificationCodeService, VERIFICATION_MAILER] },
    { provide: VerifyEmailService, useFactory: (connection: Connection, users: Model<Usuario>, tokens: Model<TokenCuenta>, codes: VerificationCodeService, policy: VerificationPolicy) => new VerifyEmailService(connection, users, tokens, codes, policy), inject: [getConnectionToken(), getModelToken('Usuario'), getModelToken('TokenCuenta'), VerificationCodeService, POLICY] },
    { provide: ResendVerificationService, useFactory: (connection: Connection, users: Model<Usuario>, tokens: Model<TokenCuenta>, codes: VerificationCodeService, mailer: VerificationMailer, policy: VerificationPolicy) => new ResendVerificationService(connection, users, tokens, codes, mailer, policy), inject: [getConnectionToken(), getModelToken('Usuario'), getModelToken('TokenCuenta'), VerificationCodeService, VERIFICATION_MAILER, POLICY] },
    { provide: LoginService, useFactory: (connection: Connection, users: Model<Usuario>, sessions: Model<Sesion>, passwords: PasswordService, access: AccessTokenService, opaque: OpaqueTokenService, config: ConfigService) => new LoginService(connection, users, sessions, passwords, access, opaque, config), inject: [getConnectionToken(), getModelToken('Usuario'), getModelToken('Sesion'), PasswordService, AccessTokenService, OpaqueTokenService, ConfigService] },
    { provide: SessionService, useFactory: (connection: Connection, users: Model<Usuario>, sessions: Model<Sesion>, access: AccessTokenService, opaque: OpaqueTokenService, config: ConfigService) => new SessionService(connection, users, sessions, access, opaque, config), inject: [getConnectionToken(), getModelToken('Usuario'), getModelToken('Sesion'), AccessTokenService, OpaqueTokenService, ConfigService] },
    { provide: IdentityOperationsService, useFactory: (limiter: OriginRateLimitService, registration: RegistrationService, verification: VerifyEmailService, resend: ResendVerificationService, login: LoginService, sessions: SessionService) => new IdentityOperationsService(limiter, registration, verification, resend, login, sessions), inject: [OriginRateLimitService, RegistrationService, VerifyEmailService, ResendVerificationService, LoginService, SessionService] },
  ],
  exports: [MongooseModule, IdentityOperationsService, VERIFICATION_MAILER, AuthenticatedIdentityService],
})
export class IdentityModule {}
