import { ForbiddenException, UnsupportedMediaTypeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CookieOptions, Request } from 'express';

export function refreshCookieOptions(config: ConfigService): CookieOptions {
  const production = config.get('NODE_ENV') === 'production';
  const secure = config.get<boolean>('AUTH_REFRESH_COOKIE_SECURE', production);
  if (typeof secure !== 'boolean' || (production && !secure)) throw new Error('Cookie de sesión inválida');
  return { httpOnly: true, secure, sameSite: 'strict', path: '/api/v1/auth' };
}

/** No CORS expansion or proxy trust. Browser login must opt into an exact trusted Origin. */
export function assertLoginRequest(request: Request, config: ConfigService): void {
  if (!request.is('application/json')) throw new UnsupportedMediaTypeException();
  const origin = request.headers.origin;
  if (request.headers['sec-fetch-site'] === 'cross-site' || (origin !== undefined && origin !== config.get<string>('AUTH_BROWSER_ORIGIN'))) throw new ForbiddenException();
}

export function assertSessionRequest(request: Request, config: ConfigService): void {
  assertLoginRequest(request, config);
  if (!request.headers.origin || request.headers.origin !== config.get<string>('AUTH_BROWSER_ORIGIN')) throw new ForbiddenException();
}

/** Only the exact existing cookie; duplicates and noncanonical encodings are not credentials. */
export function readRefreshCookie(request: Request): string | undefined {
  const cookies = request.headers.cookie?.split(';').map((value) => value.trim()).filter((value) => value.startsWith('lethics_refresh=')) ?? [];
  if (cookies.length !== 1) return undefined;
  const value = cookies[0].slice('lethics_refresh='.length);
  return /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value ? value : undefined;
}
