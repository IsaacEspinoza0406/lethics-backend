import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { LimitedOperation } from '../../infrastructure/rate-limit/origin-rate-limit.service';
import { AuthHttpPolicy } from './auth-http.policy';
import { Request } from 'express';
import { IdentityOperationsService } from '../identity/application/identity-operations.service';
import { authHttpFailure } from './auth-http.errors';
import { ConfigService } from '@nestjs/config';
import { assertLoginRequest, assertSessionRequest } from './login-http.policy';

const AUTH_OPERATION = Symbol('AUTH_OPERATION');
export const AuthOperation = (operation: LimitedOperation) => SetMetadata(AUTH_OPERATION, operation);
export const AUTH_ORIGIN_PERMIT = Symbol('AUTH_ORIGIN_PERMIT');
export type AuthRequest = Request & { [AUTH_ORIGIN_PERMIT]?: object };

@Injectable()
export class AuthHttpGuard implements CanActivate {
  constructor(private readonly policy: AuthHttpPolicy, private readonly reflector: Reflector, private readonly operations: IdentityOperationsService, private readonly config: ConfigService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const operation = this.reflector.get<LimitedOperation>(AUTH_OPERATION, context.getHandler());
    if (!['register', 'verify', 'resend', 'login', 'refresh', 'logout'].includes(operation)) throw new ServiceUnavailableException();
    if (!this.policy.isEnabled(operation)) throw new ServiceUnavailableException();
    const request = context.switchToHttp().getRequest<AuthRequest>();
    if (['login', 'refresh', 'logout'].includes(operation)) {
      context.switchToHttp().getResponse<{ setHeader(name: string, value: string): void }>().setHeader('Cache-Control', 'no-store');
      if (operation === 'login') assertLoginRequest(request, this.config);
      else assertSessionRequest(request, this.config);
    }
    try {
      request[AUTH_ORIGIN_PERMIT] = await this.operations.authorize(operation, request.socket.remoteAddress, false);
      await this.policy.assertReady(operation);
    } catch (error) { throw authHttpFailure(error); }
    return true;
  }
}
