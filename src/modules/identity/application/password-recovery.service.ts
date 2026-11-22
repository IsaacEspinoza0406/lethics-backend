import { BeforeApplicationShutdown, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { createHash } from 'node:crypto';
import { PasswordService } from '../../../infrastructure/security/password.service';
import { OpaqueTokenService } from '../../../infrastructure/security/opaque-token.service';
import { OriginRateLimitService } from '../../../infrastructure/rate-limit/origin-rate-limit.service';
import { Sesion, TokenCuenta, Usuario } from '../infrastructure/schemas/identity.schemas';
import { VERIFICATION_MAILER, VerificationMailer } from './verification-mailer';
import { eligibleSessionAccount } from './session-account-policy';
import { inspectIdentityIndexes } from '../infrastructure/identity-indexes';

export class PasswordResetDeniedError extends Error { constructor() { super('Solicitud de restablecimiento no válida.'); } }

@Injectable()
export class PasswordRecoveryService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(PasswordRecoveryService.name);
  private readonly pending = new Set<Promise<void>>();
  private stopping = false;
  constructor(@InjectConnection() private readonly connection: Connection,
    @InjectModel('Usuario') private readonly users: Model<Usuario>, @InjectModel('TokenCuenta') private readonly tokens: Model<TokenCuenta>,
    @InjectModel('Sesion') private readonly sessions: Model<Sesion>, private readonly passwords: PasswordService, private readonly opaque: OpaqueTokenService,
    private readonly limiter: OriginRateLimitService, @Inject(VERIFICATION_MAILER) private readonly mailer: VerificationMailer, private readonly config: ConfigService) {}

  private async assertStorage(): Promise<void> {
    if (!this.connection.db || (await inspectIdentityIndexes(this.connection.db)).some((index) => index.status !== 'ready') ||
      !(await this.connection.db.listCollections({ name: 'sesiones' }, { nameOnly: true }).toArray()).length) throw new Error('Recuperación no disponible');
  }

  async forgot(email: string): Promise<void> {
    const correo = email.trim().toLowerCase();
    await this.assertStorage();
    // Count every normalized address, whether it exists or not. Quota denial has the same public response.
    if (!(await this.limiter.consumeAccount(correo)).allowed) return;
    if (this.stopping || this.pending.size >= 100) throw new Error('Recuperación no disponible');
    // Defer ALL account lookups and delivery; SMTP latency must not reveal account existence.
    const work = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.issue(correo))
      .catch(() => { this.logger.error('No se pudo completar una solicitud de recuperación.'); })
      .finally(() => { this.pending.delete(work); });
    this.pending.add(work);
  }

  /** Internal lifecycle/test boundary, not an HTTP delivery acknowledgement. No durable queue. */
  async waitForPendingRequests(): Promise<void> { await Promise.allSettled([...this.pending]); }
  async beforeApplicationShutdown(): Promise<void> { this.stopping = true; await this.waitForPendingRequests(); }

  private async issue(correo: string): Promise<void> {
    const user = await this.users.findOne({ correo }).lean();
    if (!user || !eligibleSessionAccount(user)) return;
    const ttl = this.config.get<number>('PASSWORD_RECOVERY_TTL_SECONDS', 900);
    if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 900 || ttl % 60 !== 0 || !this.mailer.sendPasswordRecovery) throw new Error('Recuperación no disponible');
    const token = this.opaque.generate(), tokenHash = this.opaque.digest('password-reset', token);
    // One stable token slot per user serializes concurrent issuance without new fields or collections.
    // A collision with another identity/type fails closed; it can never overwrite that document.
    const id = new Types.ObjectId(createHash('sha256').update(`lethics:password-reset-slot:${user._id.toString()}`).digest().subarray(0, 12));
    const transaction = await this.connection.startSession();
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await transaction.withTransaction(async () => {
            const current = await this.users.findById(user._id).session(transaction).lean();
            if (!current || !eligibleSessionAccount(current) || current.correo !== correo) return;
            const now = new Date();
            await this.tokens.updateMany({ usuarioId: user._id, tipo: 'recuperacion', _id: { $ne: id }, revocadoEn: null }, { $set: { revocadoEn: now } }, { session: transaction });
            await this.tokens.updateOne({ _id: id, usuarioId: user._id, tipo: 'recuperacion' }, { $set: { tokenHash, creadoEn: now, expiraEn: new Date(now.getTime() + ttl * 1000), usadoEn: null, revocadoEn: null } }, { upsert: true, session: transaction });
          }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
          break;
        } catch (error) {
          // MongoDB 8 does not automatically retry duplicate-key upsert races in transactions.
          if ((error as { code?: number }).code !== 11000 || attempt >= 2) throw error;
        }
      }
    } finally { await transaction.endSession(); }
    // A state change may have prevented issuance. Never mail a token that was not installed.
    if (!(await this.tokens.exists({ _id: id, tokenHash, usadoEn: null, revocadoEn: null }))) return;
    try { await this.mailer.sendPasswordRecovery(correo, token, ttl / 60); }
    catch {
      await this.tokens.updateOne({ _id: id, tokenHash, tipo: 'recuperacion', usadoEn: null }, { $set: { revocadoEn: new Date() } });
      this.logger.warn('Entrega de recuperación no confirmada; credencial invalidada.');
      // 202 acknowledges a request, never successful delivery. Do not enumerate on recipient rejection.
    }
  }

  async reset(token: string, password: string): Promise<void> {
    let tokenHash: string;
    try { tokenHash = this.opaque.digest('password-reset', token); } catch { throw new PasswordResetDeniedError(); }
    await this.assertStorage();
    // Same password policy as registration, including the application boundary for non-HTTP callers.
    if (typeof password !== 'string' || !password.length || password.length > 1024) throw new PasswordResetDeniedError();
    const contraseñaHash = await this.passwords.hash(password);
    const transaction = await this.connection.startSession();
    try {
      await transaction.withTransaction(async () => {
        const now = new Date();
        const record = await this.tokens.findOne({ tipo: 'recuperacion', tokenHash, usadoEn: null, revocadoEn: null, expiraEn: { $gt: now } }).session(transaction).lean();
        if (!record || !(record.usuarioId instanceof Types.ObjectId)) throw new PasswordResetDeniedError();
        const user = await this.users.findById(record.usuarioId).session(transaction).lean();
        if (!user || !eligibleSessionAccount(user)) throw new PasswordResetDeniedError();
        const consumed = await this.tokens.updateOne({ _id: record._id, tipo: 'recuperacion', tokenHash, usadoEn: null, revocadoEn: null, expiraEn: { $gt: now } }, { $set: { usadoEn: now } }, { session: transaction });
        if (consumed.modifiedCount !== 1) throw new PasswordResetDeniedError();
        const updated = await this.users.updateOne({ _id: user._id }, { $set: { contraseñaHash } }, { session: transaction });
        if (updated.modifiedCount !== 1) throw new PasswordResetDeniedError();
        await this.tokens.updateMany({ usuarioId: user._id, tipo: 'recuperacion', usadoEn: null, revocadoEn: null }, { $set: { revocadoEn: now } }, { session: transaction });
        await this.sessions.updateMany({ usuarioId: user._id, revocadaEn: null }, { $set: { revocadaEn: now } }, { session: transaction });
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } finally { await transaction.endSession(); }
  }
}
