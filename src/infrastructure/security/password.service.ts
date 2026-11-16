import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    if (typeof password !== 'string' || password.length === 0) throw new TypeError('Contraseña inválida');
    return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  }

  async verify(hash: string, password: string): Promise<boolean> {
    if (typeof hash !== 'string' || !hash.startsWith('$argon2id$') || typeof password !== 'string' || password.length === 0) return false;
    try { return await argon2.verify(hash, password); } catch { return false; }
  }
}
