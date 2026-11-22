import { Schema } from 'mongoose';
import { EVIDENCE_BOUND, ProjectSubmission, validSubmission } from '../domain/project';

const EvidenceSchema = new Schema({
  tipo: { type: String, required: true, enum: ['enlace', 'archivo'] },
  url: { type: String, maxlength: 2048 }, referencia: { type: String, maxlength: 128 },
  nombre: { type: String, maxlength: 255 }, mime: { type: String, maxlength: 128 },
  // Runtime Int32; Mongoose's inferred numeric declarations expect NumberConstructor.
  bytes: { type: Schema.Types.Int32 as unknown as NumberConstructor, min: 1, max: 2147483647 },
  sha256: { type: String, match: /^[a-f\d]{64}$/ },
}, { _id: false, strict: 'throw' });
export const ProjectSchema = new Schema<ProjectSubmission>({
  usuarioId: { type: Schema.Types.ObjectId, ref: 'Usuario', required: true },
  cursoId: { type: Schema.Types.ObjectId, ref: 'Curso', required: true },
  solicitudId: { type: String, required: true, maxlength: 128, match: /\S/ },
  fechaEntrega: { type: Date, required: true },
  estado: { type: String, required: true, enum: ['registrada'] },
  evidencias: { type: [EvidenceSchema], required: true, validate: (v: unknown[]) => v.length >= 1 && v.length <= EVIDENCE_BOUND },
}, { collection: 'entregas_proyecto', autoCreate: false, autoIndex: false, versionKey: false, strict: 'throw' });
ProjectSchema.pre('validate', function () {
  if (!validSubmission(this.toObject({ transform: false }) as ProjectSubmission)) this.invalidate('evidencias', 'Entrega inválida');
});
ProjectSchema.pre('save', function () { if (!this.isNew) throw new Error('Entrega histórica inmutable'); });
ProjectSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'], function () { throw new Error('Entrega histórica inmutable'); });
// Defined for authorized provisioning only. Never installed at application startup.
ProjectSchema.index({ usuarioId: 1, solicitudId: 1 }, { name: 'usuarioId_1_solicitudId_1', unique: true, collation: { locale: 'simple' } });
