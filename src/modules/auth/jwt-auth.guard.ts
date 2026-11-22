import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessTokenService } from '../../infrastructure/security/access-token.service';
import { AuthenticatedIdentityService, PublicUserProfile } from '../identity/application/authenticated-identity.service';
import { AUTHENTICATED_USER, AuthenticatedRequest, PUBLIC_ROUTE } from './access-control';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly tokens: AccessTokenService, private readonly identities: AuthenticatedIdentityService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    delete request[AUTHENTICATED_USER];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()])) return true;
    const header = request.headers.authorization;
    const count = request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length;
    const match = typeof header === 'string' && header.length <= 8192 && /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header);
    if (!match || count > 1) throw new UnauthorizedException('Autenticación no válida.');
    let subject: string;
    try { subject = this.tokens.verify(match[1]).sub; } catch { throw new UnauthorizedException('Autenticación no válida.'); }
    let profile: PublicUserProfile | null;
    try { profile = await this.identities.findEligibleProfile(subject); } catch { throw new ServiceUnavailableException('Autenticación no disponible.'); }
    if (!profile) throw new UnauthorizedException('Autenticación no válida.');
    request[AUTHENTICATED_USER] = Object.freeze({ id: profile.id, rol: profile.rol });
    return true;
  }
}
