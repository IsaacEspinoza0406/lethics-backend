import { Connection, Model } from 'mongoose';
import { TokenCuenta, Usuario } from '../infrastructure/schemas/identity.schemas';
import { VerificationCodeService } from '../infrastructure/verification-code.service';
import { defaultVerificationPolicy, VerificationPolicy } from './verification-policy';
import { validVerificationState, validVerificationToken } from '../infrastructure/legacy-security';

/** Use case: the HTTP boundary enforces origin controls and public response handling. */
export class VerifyEmailService {
  constructor(private readonly connection: Connection, private readonly users: Model<Usuario>, private readonly tokens: Model<TokenCuenta>, private readonly codes: VerificationCodeService, private readonly policy: VerificationPolicy = defaultVerificationPolicy, private readonly clock: () => Date = () => new Date()) {}

  async verify(correo: string, codigo: string): Promise<boolean> {
    if (!/^[0-9]{6}$/.test(codigo)) return false;
    const session = await this.connection.startSession();
    try {
      return await session.withTransaction(async () => {
        const now = this.clock();
        const user = await this.users.findOneAndUpdate({ correo: correo.trim().toLowerCase(), verificadoEn: null, 'seguridadVerificacion.revision': { $gte: 0 } }, { $inc: { 'seguridadVerificacion.revision': 1 } }, { session, new: true });
        if (!user?.seguridadVerificacion || !validVerificationState(user.seguridadVerificacion)) return false;
        const state = user.seguridadVerificacion;
        const reset = now.getTime() - state.fallosInicio.getTime() >= 3_600_000;
        const failures = reset ? 0 : state.fallos;
        if (failures >= this.policy.maxFailuresPerHour) return false;
        const token = await this.tokens.findOne({ _id: state.tokenActualId, usuarioId: user._id, tipo: 'verificacion', versionHmac: 2, expiraEn: { $gt: now }, usadoEn: null, revocadoEn: null, intentosFallidos: { $gte: 0, $lt: 5 } }).select('+tokenHash').session(session);
        if (!token || !validVerificationToken(token.toObject())) return false;
        if (!this.codes.verify(user._id, token._id, codigo, token.tokenHash)) {
          await this.tokens.updateOne({ _id: token._id }, { $inc: { intentosFallidos: 1 } }, { session });
          await this.users.updateOne({ _id: user._id }, { $set: { 'seguridadVerificacion.fallos': failures + 1, 'seguridadVerificacion.fallosInicio': reset ? now : state.fallosInicio } }, { session });
          return false;
        }
        const consumed = await this.tokens.updateOne({ _id: token._id, usadoEn: null, revocadoEn: null, expiraEn: { $gt: now }, intentosFallidos: { $lt: 5 } }, { $set: { usadoEn: now } }, { session });
        const updated = await this.users.updateOne({ _id: user._id, verificadoEn: null }, { $set: { verificadoEn: now } }, { session });
        if (consumed.modifiedCount !== 1 || updated.modifiedCount !== 1) throw new Error('No se pudo completar la verificación');
        return true;
      });
    } finally { await session.endSession(); }
  }
}
