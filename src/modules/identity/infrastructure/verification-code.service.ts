import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Types } from 'mongoose';

/** Separate HMAC key is required; this component does not provide rate limiting. */
export class VerificationCodeService {
  private readonly key: Buffer;

  constructor(key: Buffer, jwtKey: Buffer) {
    if (key.length !== 32 || new Set(key).size < 16 || key.equals(jwtKey)) throw new Error('Clave de verificación inválida o reutilizada');
    this.key = Buffer.from(key);
  }

  generate(): string { return randomInt(0, 1_000_000).toString().padStart(6, '0'); }

  digest(userId: Types.ObjectId, tokenId: Types.ObjectId, code: string): string {
    if (!(userId instanceof Types.ObjectId) || !(tokenId instanceof Types.ObjectId) || typeof code !== 'string' || !/^[0-9]{6}$/.test(code)) throw new TypeError('Código o usuario inválido');
    return createHmac('sha256', this.key).update(`lethics:verificacion:v2:${userId.toHexString()}:${tokenId.toHexString()}:${code}`, 'utf8').digest('hex');
  }

  verify(userId: Types.ObjectId, tokenId: Types.ObjectId, code: string, hash: string): boolean {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return false;
    try { return timingSafeEqual(Buffer.from(this.digest(userId, tokenId, code), 'hex'), Buffer.from(hash, 'hex')); } catch { return false; }
  }
}
