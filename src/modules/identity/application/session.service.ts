import { ConfigService } from '@nestjs/config';
import { Connection, Model, Types } from 'mongoose';
import { AccessTokenService } from '../../../infrastructure/security/access-token.service';
import { OpaqueTokenService } from '../../../infrastructure/security/opaque-token.service';
import { Sesion, Usuario } from '../infrastructure/schemas/identity.schemas';
import { LoginResult } from './login.service';
import { eligibleSessionAccount } from './session-account-policy';

export class SessionDeniedError extends Error { constructor() { super('Sesión no válida.'); } }

/** Each issued hash is retained in sesiones; no in-place hash replacement or Redis history. */
export class SessionService {
  constructor(private readonly connection: Connection, private readonly users: Model<Usuario>, private readonly sessions: Model<Sesion>,
    private readonly access: AccessTokenService, private readonly opaque: OpaqueTokenService, private readonly config: ConfigService) {}

  private digest(token: string | undefined): string | undefined {
    try { return token === undefined ? undefined : this.opaque.digest('refresh', token); } catch { return undefined; }
  }
  private async assertStorage(): Promise<void> {
    if (!this.connection.db || !(await this.connection.db.listCollections({ name: 'sesiones' }, { nameOnly: true }).toArray()).length) throw new Error('Sesiones no disponibles');
  }

  async refresh(token: string | undefined): Promise<LoginResult> {
    const hash = this.digest(token);
    if (!hash) throw new SessionDeniedError();
    await this.assertStorage();
    const replacement = this.opaque.generate(), id = new Types.ObjectId();
    const transaction = await this.connection.startSession();
    let result: LoginResult | null | undefined;
    try {
      result = await transaction.withTransaction(async () => {
        // Ambiguous imported hashes must never select an arbitrary session/family.
        const candidates = await this.sessions.find({ refreshTokenHash: hash }).limit(2).session(transaction).lean();
        if (candidates.length > 1) throw new Error('Estado de sesiones ambiguo');
        const current = candidates[0];
        if (!current) return null;
        const now = new Date();
        if (!(current.usuarioId instanceof Types.ObjectId) || typeof current.familia !== 'string' || !current.familia.trim() || !(current.expiraEn instanceof Date) || !Number.isFinite(current.expiraEn.getTime())) return null;
        const family = { usuarioId: current.usuarioId, familia: current.familia, revocadaEn: null };
        if (current.revocadaEn !== null || current.expiraEn.getTime() <= now.getTime()) {
          await this.sessions.updateMany(family, { $set: { revocadaEn: now } }, { session: transaction });
          return null; // Commit revocation BEFORE the public 401; throwing here would roll it back.
        }
        const user = await this.users.findById(current.usuarioId).session(transaction);
        if (!eligibleSessionAccount(user)) {
          await this.sessions.updateMany(family, { $set: { revocadaEn: now } }, { session: transaction });
          return null;
        }
        const ttl = this.config.getOrThrow<number>('JWT_ACCESS_TTL_SECONDS');
        if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 900) throw new Error('Duración de acceso inválida');
        const accessToken = this.access.sign(current.usuarioId.toString());
        const consumed = await this.sessions.updateOne({ _id: current._id, refreshTokenHash: hash, revocadaEn: null, expiraEn: { $gt: now } }, { $set: { revocadaEn: now } }, { session: transaction });
        if (consumed.modifiedCount !== 1) throw new Error('No se pudo consumir sesión');
        await this.sessions.create([{ _id: id, usuarioId: current.usuarioId, refreshTokenHash: this.opaque.digest('refresh', replacement), creadaEn: now,
          expiraEn: current.expiraEn, revocadaEn: null, familia: current.familia }], { session: transaction });
        return { accessToken, expiresIn: ttl, refreshToken: replacement, refreshExpiresAt: current.expiraEn };
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } finally { await transaction.endSession(); }
    if (!result) throw new SessionDeniedError();
    return result;
  }

  async logout(token: string | undefined): Promise<void> {
    const hash = this.digest(token);
    if (!hash) return; // No identified session; public idempotent logout still clears the cookie.
    await this.assertStorage();
    const transaction = await this.connection.startSession();
    try {
      await transaction.withTransaction(async () => {
        const candidates = await this.sessions.find({ refreshTokenHash: hash }).limit(2).session(transaction).lean();
        if (candidates.length > 1) throw new Error('Estado de sesiones ambiguo');
        const current = candidates[0];
        if (!current) return;
        const filter = typeof current.familia === 'string' && current.familia.trim()
          ? { usuarioId: current.usuarioId, familia: current.familia, revocadaEn: null }
          : { _id: current._id, revocadaEn: null };
        // A rotated cookie also logs out its live successor; unrelated families remain intact.
        await this.sessions.updateMany(filter, { $set: { revocadaEn: new Date() } }, { session: transaction });
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } finally { await transaction.endSession(); }
  }
}
