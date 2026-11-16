import { Schema, Types } from 'mongoose';
import { isEmail } from 'class-validator';

// These interfaces describe the available persistence fields, not an API contract.
export interface Usuario {
  nombre: string;
  correo: string;
  contraseñaHash: string;
  rol: string;
  perfil?: unknown;
  verificadoEn?: Date | null;
  zonaHoraria?: string | null;
  creadoEn?: Date | null;
}

export interface TokenCuenta {
  usuarioId: Types.ObjectId;
  tipo: 'verificacion' | 'recuperacion';
  tokenHash: string;
  creadoEn?: Date | null;
  expiraEn: Date;
  usadoEn?: Date | null;
  revocadoEn?: Date | null;
}

export interface Sesion {
  usuarioId: Types.ObjectId;
  refreshTokenHash: string;
  creadaEn?: Date | null;
  expiraEn: Date;
  revocadaEn?: Date | null;
  familia?: string | null;
}

// Defense in depth for hydrated documents, including explicit +secret projections.
// Lean queries and direct MongoDB reads do not run these transforms.
function hideSecret(secret: string) {
  return {
    transform: (_doc: unknown, result: Record<string, unknown>) => {
      delete result[secret];
      return result;
    },
  };
}

export const UsuarioSchema = new Schema<Usuario>({
  nombre: { type: String, required: true, trim: true },
  correo: { type: String, required: true, trim: true, lowercase: true, validate: { validator: (value: string) => isEmail(value), message: 'Correo inválido' } },
  contraseñaHash: { type: String, required: true, select: false, match: /\S/ },
  rol: { type: String, required: true, trim: true },
  perfil: Schema.Types.Mixed,
  verificadoEn: Date,
  zonaHoraria: String,
  creadoEn: Date,
}, { collection: 'usuarios', versionKey: false, autoCreate: false, autoIndex: false, toJSON: hideSecret('contraseñaHash'), toObject: hideSecret('contraseñaHash') });
UsuarioSchema.index({ correo: 1 }, { unique: true });

export const TokenCuentaSchema = new Schema<TokenCuenta>({
  usuarioId: { type: Schema.Types.ObjectId, ref: 'Usuario', required: true },
  tipo: { type: String, enum: ['verificacion', 'recuperacion'], required: true },
  tokenHash: { type: String, required: true, select: false, match: /\S/ },
  creadoEn: Date,
  expiraEn: { type: Date, required: true },
  usadoEn: Date,
  revocadoEn: Date,
}, { collection: 'tokens_cuenta', versionKey: false, autoCreate: false, autoIndex: false, toJSON: hideSecret('tokenHash'), toObject: hideSecret('tokenHash') });
TokenCuentaSchema.index({ tokenHash: 1 }, { unique: true });

export const SesionSchema = new Schema<Sesion>({
  usuarioId: { type: Schema.Types.ObjectId, ref: 'Usuario', required: true },
  refreshTokenHash: { type: String, required: true, select: false, match: /\S/ },
  creadaEn: Date,
  expiraEn: { type: Date, required: true },
  revocadaEn: Date,
  familia: String,
}, { collection: 'sesiones', versionKey: false, autoCreate: false, autoIndex: false, toJSON: hideSecret('refreshTokenHash'), toObject: hideSecret('refreshTokenHash') });
