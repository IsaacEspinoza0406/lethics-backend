import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type TokenPurpose = 'account' | 'refresh';
const PURPOSES: readonly string[] = ['account', 'refresh'];

@Injectable()
export class OpaqueTokenService {
  generate(): string { return randomBytes(32).toString('base64url'); }

  digest(purpose: TokenPurpose, token: string): string {
    if (!PURPOSES.includes(purpose) || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) throw new TypeError('Token inválido');
    return createHash('sha256').update(`lethics:${purpose}:`, 'utf8').update(token, 'utf8').digest('hex');
  }

  verify(purpose: TokenPurpose, token: string, digest: string): boolean {
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) return false;
    try { return timingSafeEqual(Buffer.from(this.digest(purpose, token), 'hex'), Buffer.from(digest, 'hex')); } catch { return false; }
  }
}
