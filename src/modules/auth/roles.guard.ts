import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTHENTICATED_USER, AuthenticatedRequest, PUBLIC_ROUTE, REQUIRED_ROLES } from './access-control';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets)) return true;
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>()[AUTHENTICATED_USER];
    if (!user) throw new UnauthorizedException('Autenticación no válida.');
    const roles = this.reflector.getAllAndOverride<readonly string[]>(REQUIRED_ROLES, targets);
    if (roles !== undefined && !roles.some((role) => role === 'estudiante' && role === user.rol)) throw new ForbiddenException('Acceso no permitido.');
    return true;
  }
}
