import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import * as jwt from 'jsonwebtoken';

export interface AccessTokenClaims { sub: string; jti: string; iat: number; exp: number }

@Injectable()
export class AccessTokenService {
  private readonly key: Buffer;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly ttl: number;

  constructor(config: ConfigService) {
    this.key = Buffer.from(config.getOrThrow<string>('JWT_ACCESS_SECRET_BASE64'), 'base64');
    this.issuer = config.getOrThrow<string>('JWT_ACCESS_ISSUER');
    this.audience = config.getOrThrow<string>('JWT_ACCESS_AUDIENCE');
    this.ttl = config.getOrThrow<number>('JWT_ACCESS_TTL_SECONDS');
  }

  sign(subject: string): string {
    if (typeof subject !== 'string' || !subject.trim()) throw new TypeError('Subject inválido');
    return jwt.sign({}, this.key, { algorithm: 'HS256', issuer: this.issuer, audience: this.audience, subject, jwtid: randomUUID(), expiresIn: this.ttl });
  }

  verify(token: string): AccessTokenClaims {
    const payload = jwt.verify(token, this.key, { algorithms: ['HS256'], issuer: this.issuer, audience: this.audience });
    if (typeof payload === 'string' || typeof payload.sub !== 'string' || !payload.sub.trim() || typeof payload.jti !== 'string' || !payload.jti.trim() || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat! > Math.floor(Date.now() / 1000) || payload.exp! <= payload.iat!) throw new jwt.JsonWebTokenError('Claims inválidos');
    return { sub: payload.sub, jti: payload.jti, iat: payload.iat!, exp: payload.exp! };
  }
}
