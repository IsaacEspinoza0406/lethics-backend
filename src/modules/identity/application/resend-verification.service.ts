import { Connection, Model, Types } from 'mongoose';
import { TokenCuenta, Usuario } from '../infrastructure/schemas/identity.schemas';
import { VerificationCodeService } from '../infrastructure/verification-code.service';
import { VerificationMailer } from './verification-mailer';
import { defaultVerificationPolicy, VerificationPolicy } from './verification-policy';

/** Internal only: per-origin abuse controls are required before exposure. */
export class ResendVerificationService {
  constructor(private readonly connection: Connection, private readonly users: Model<Usuario>, private readonly tokens: Model<TokenCuenta>, private readonly codes: VerificationCodeService, private readonly mailer: VerificationMailer, private readonly policy: VerificationPolicy = defaultVerificationPolicy, private readonly clock: () => Date = () => new Date()) {}

  async resend(correo: string): Promise<void> {
    const normalized = correo.trim().toLowerCase();
    const session = await this.connection.startSession();
    let codeToSend: string | undefined;
    try {
      await session.withTransaction(async () => {
        codeToSend = undefined;
        const now = this.clock();
        const user = await this.users.findOneAndUpdate({ correo: normalized, verificadoEn: null, 'seguridadVerificacion.revision': { $gte: 0 } }, { $inc: { 'seguridadVerificacion.revision': 1 } }, { session, new: true });
        if (!user?.seguridadVerificacion) return;
        const state = user.seguridadVerificacion;
        if (now.getTime() - state.ultimaEmision.getTime() < 60_000) return;
        const reset = now.getTime() - state.emisionesInicio.getTime() >= 3_600_000;
        const emissions = reset ? 0 : state.emisiones;
        if (emissions >= this.policy.maxEmissionsPerHour) return;
        const tokenId = new Types.ObjectId();
        const previous = await this.tokens.findOne({ _id: state.tokenActualId, usuarioId: user._id, versionHmac: 2 }).select('+tokenHash').session(session);
        if (!previous) throw new Error('Estado de verificación requiere migración');
        let code = '';
        for (let attempt = 0; attempt < 16; attempt++) {
          const candidate = this.codes.generate();
          if (!this.codes.verify(user._id, previous._id, candidate, previous.tokenHash)) { code = candidate; break; }
        }
        if (!code) throw new Error('No se pudo generar un código nuevo');
        await this.tokens.updateMany({ usuarioId: user._id, tipo: 'verificacion', usadoEn: null, revocadoEn: null }, { $set: { revocadoEn: now } }, { session });
        await this.tokens.create([{ _id: tokenId, usuarioId: user._id, tipo: 'verificacion', tokenHash: this.codes.digest(user._id, tokenId, code), versionHmac: 2, intentosFallidos: 0, creadoEn: now, expiraEn: new Date(now.getTime() + 300_000), usadoEn: null, revocadoEn: null }], { session });
        await this.users.updateOne({ _id: user._id }, { $set: { 'seguridadVerificacion.tokenActualId': tokenId, 'seguridadVerificacion.ultimaEmision': now, 'seguridadVerificacion.emisionesInicio': reset ? now : state.emisionesInicio, 'seguridadVerificacion.emisiones': emissions + 1 } }, { session });
        codeToSend = code;
      });
    } finally { await session.endSession(); }
    if (codeToSend) {
      try { await this.mailer.sendVerification(normalized, codeToSend); } catch { throw new Error('No se pudo procesar el envío'); }
    }
  }
}
