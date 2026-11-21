import { Connection, Model, Types } from 'mongoose';
import { PasswordService } from '../../../infrastructure/security/password.service';
import { TokenCuenta, Usuario } from '../infrastructure/schemas/identity.schemas';
import { VerificationCodeService } from '../infrastructure/verification-code.service';
import { VerificationMailer } from './verification-mailer';
import { compatibleIdentityIndex } from '../infrastructure/identity-indexes';

/** Internal use case: no HTTP route; callers must enforce shared abuse controls. */
export class RegistrationService {
  constructor(
    private readonly connection: Connection,
    private readonly users: Model<Usuario>,
    private readonly tokens: Model<TokenCuenta>,
    private readonly passwords: PasswordService,
    private readonly codes: VerificationCodeService,
    private readonly mailer: VerificationMailer,
  ) {}

  async register(input: { nombre: string; correo: string; contraseña: string }): Promise<void> {
    // Do not trust a schema declaration: the unique indexes must already exist.
    const [userIndexes, tokenIndexes] = await Promise.all([this.users.collection.indexes(), this.tokens.collection.indexes()]);
    if (!userIndexes.some((i) => compatibleIdentityIndex(i, 'correo', 'correo_1')) ||
        !tokenIndexes.some((i) => compatibleIdentityIndex(i, 'tokenHash', 'tokenHash_1'))) throw new Error('Índices de identidad no disponibles');
    const correo = input.correo.trim().toLowerCase();
    const contraseñaHash = await this.passwords.hash(input.contraseña);
    const usuarioId = new Types.ObjectId();
    const tokenId = new Types.ObjectId();
    const code = this.codes.generate();
    const creadoEn = new Date();
    const session = await this.connection.startSession();
    try {
      try {
        await session.withTransaction(async () => {
          await this.users.create([{ _id: usuarioId, nombre: input.nombre, correo, contraseñaHash, rol: 'estudiante', verificadoEn: null, creadoEn, seguridadVerificacion: { tokenActualId: tokenId, ultimaEmision: creadoEn, emisionesInicio: creadoEn, emisiones: 1, fallosInicio: creadoEn, fallos: 0, revision: 0 } }], { session });
          await this.tokens.create([{ _id: tokenId, usuarioId, tipo: 'verificacion', tokenHash: this.codes.digest(usuarioId, tokenId, code), versionHmac: 2, intentosFallidos: 0, creadoEn, expiraEn: new Date(creadoEn.getTime() + 300_000), usadoEn: null, revocadoEn: null }], { session });
        });
      } catch (error: unknown) {
        const duplicate = error as { code?: number; keyPattern?: { correo?: number } };
        if (duplicate.code === 11000 && duplicate.keyPattern?.correo === 1) return;
        throw error;
      }
    } finally { await session.endSession(); }
    try { await this.mailer.sendVerification(correo, code); } catch { throw new Error('No se pudo procesar el envío'); }
  }
}
