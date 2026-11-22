import { createParamDecorator, ExecutionContext, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

export const PUBLIC_ROUTE = Symbol('PUBLIC_ROUTE');
export const REQUIRED_ROLES = Symbol('REQUIRED_ROLES');
export const AUTHENTICATED_USER = Symbol('AUTHENTICATED_USER');
export type ApprovedRole = 'estudiante';
export interface AuthenticatedUser { readonly id: string; readonly rol: string }
export type AuthenticatedRequest = Request & { [AUTHENTICATED_USER]?: Readonly<AuthenticatedUser> };
export const Public = (value = true) => SetMetadata(PUBLIC_ROUTE, value);
export const Roles = (...roles: ApprovedRole[]) => SetMetadata(REQUIRED_ROLES, Object.freeze(roles));
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): Readonly<AuthenticatedUser> => {
  const user = context.switchToHttp().getRequest<AuthenticatedRequest>()[AUTHENTICATED_USER];
  if (!user) throw new UnauthorizedException('Autenticación no válida.');
  return user;
});
