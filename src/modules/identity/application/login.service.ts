import { OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, Model, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { PasswordService } from '../../../infrastructure/security/password.service';
import { AccessTokenService } from '../../../infrastructure/security/access-token.service';
import { OpaqueTokenService } from '../../../infrastructure/security/opaque-token.service';
import { Usuario, Sesion } from '../infrastructure/schemas/identity.schemas';
import { eligibleSessionAccount } from './session-account-policy';

export class LoginDeniedError extends Error { constructor() { super('Credenciales no válidas.'); } }
export interface LoginResult { accessToken: string; expiresIn: number; refreshToken: string; refreshExpiresAt: Date }

/** No cookie or HTTP dependencies. Secrets in this result are consumed only by the HTTP boundary. */
export class LoginService implements OnModuleInit {
  private dummyHash = '';
  constructor(private readonly connection: Connection, private readonly users: Model<Usuario>, private readonly sessions: Model<Sesion>,
    private readonly passwords: PasswordService, private readonly access: AccessTokenService, private readonly opaque: OpaqueTokenService,
    private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> { this.dummyHash = await this.passwords.hash(this.opaque.generate()); }

  async login(input: { correo: string; contraseña: string }): Promise<LoginResult> {
    if (!this.dummyHash || !this.connection.db) throw new Error('Login no disponible');
    // Mongoose autoCreate=false does not prevent implicit collection creation by insert.
    if (!(await this.connection.db.listCollections({ name: 'sesiones' }, { nameOnly: true }).toArray()).length) throw new Error('Sesiones no disponibles');
    const correo = input.correo.trim().toLowerCase();
    const user = await this.users.findOne({ correo }).select('+contraseñaHash');
    const hasHash = typeof user?.contraseñaHash === 'string' && /^\$argon2id\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/.test(user.contraseñaHash);
    const matches = await this.passwords.verify(hasHash ? user!.contraseñaHash : this.dummyHash, input.contraseña);
    if (!user || !hasHash || !matches || !eligibleSessionAccount(user)) throw new LoginDeniedError();
    const ttl = this.config.getOrThrow<number>('AUTH_REFRESH_TTL_SECONDS');
    const accessTtl = this.config.getOrThrow<number>('JWT_ACCESS_TTL_SECONDS');
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 604800 || !Number.isSafeInteger(accessTtl) || accessTtl < 1 || accessTtl > 900) throw new Error('Duración de sesión inválida');
    const refreshToken = this.opaque.generate(), created = new Date(), expires = new Date(created.getTime() + ttl * 1000);
    const accessToken = this.access.sign(user._id.toString());
    const id = new Types.ObjectId(), family = randomUUID();
    // A fresh salted encoding is a real write on the shared user document. This serializes
    // session creation with password reset; a no-op $set would not provide that guarantee.
    const loginHash = await this.passwords.hash(input.contraseña);
    const transaction = await this.connection.startSession();
    try {
      await transaction.withTransaction(async () => {
        const current = await this.users.findById(user._id).select('+contraseñaHash').session(transaction);
        if (!current || !eligibleSessionAccount(current) || (current.contraseñaHash !== user.contraseñaHash && !(await this.passwords.verify(current.contraseñaHash, input.contraseña)))) throw new LoginDeniedError();
        const updated = await this.users.updateOne({ _id: user._id, contraseñaHash: current.contraseñaHash }, { $set: { contraseñaHash: loginHash } }, { session: transaction });
        if (updated.modifiedCount !== 1) throw new LoginDeniedError();
        await this.sessions.create([{ _id: id, usuarioId: user._id, refreshTokenHash: this.opaque.digest('refresh', refreshToken),
          creadaEn: created, expiraEn: expires, revocadaEn: null, familia: family }], { session: transaction });
      });
    } finally { await transaction.endSession(); }
    return { accessToken, expiresIn: accessTtl, refreshToken, refreshExpiresAt: expires };
  }
}
