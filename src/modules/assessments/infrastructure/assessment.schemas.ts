import { Schema, SchemaDefinitionProperty, SchemaTypeOptions } from 'mongoose';
import { Attempt, Evaluation, validEvaluation, normalizeAnswers } from '../domain/assessment';
import { calculateGrade } from '../domain/grading';

const text = (max: number) => ({ type: String, required: true, maxlength: max, match: /\S/ });
// Mongoose 8's number schema declarations omit Int32/Double despite supporting them at runtime.
// Keep that compatibility assertion at the schema boundary; hydrated Double is normalized with Number().
const int32 = (options: SchemaTypeOptions<number>): SchemaDefinitionProperty<number> => ({ ...options, type: Schema.Types.Int32 }) as unknown as SchemaDefinitionProperty<number>;
const double = (options: SchemaTypeOptions<number>): SchemaDefinitionProperty<number> => ({ ...options, type: Schema.Types.Double }) as unknown as SchemaDefinitionProperty<number>;
const OptionSchema = new Schema({ id: text(128), texto: text(2000) }, { _id: false, strict: 'throw' });
const QuestionSchema = new Schema({ id: text(128), texto: text(4000), opciones: { type: [OptionSchema], required: true }, opcionCorrectaId: { ...text(128), select: false } }, { _id: false, strict: 'throw' });
const AnswerSchema = new Schema({ preguntaId: text(128), opcionId: text(128) }, { _id: false, strict: 'throw' });

export const EvaluationSchema = new Schema<Evaluation>({
  cursoId: { type: Schema.Types.ObjectId, ref: 'Curso', required: true },
  moduloId: { type: Schema.Types.ObjectId, ref: 'Modulo', default: null },
  tipo: { type: String, required: true, enum: ['cuestionario', 'examen_final'] },
  version: int32({ required: true, min: 1 }),
  minimoAprobatorio: int32({ required: true, enum: [70] }),
  estado: { type: String, required: true, enum: ['borrador', 'publicado'] },
  preguntas: { type: [QuestionSchema], required: true },
}, { collection: 'evaluaciones', autoCreate: false, autoIndex: false, versionKey: false, strict: 'throw' });
EvaluationSchema.pre('validate', function () {
  if (!validEvaluation(this.toObject({ transform: false }) as Evaluation)) this.invalidate('preguntas', 'Estructura de evaluación inválida');
});

export const AttemptSchema = new Schema<Attempt>({
  usuarioId: { type: Schema.Types.ObjectId, ref: 'Usuario', required: true },
  evaluacionId: { type: Schema.Types.ObjectId, ref: 'Evaluacion', required: true },
  cursoId: { type: Schema.Types.ObjectId, ref: 'Curso', required: true },
  moduloId: { type: Schema.Types.ObjectId, ref: 'Modulo', default: null },
  version: int32({ required: true, min: 1 }),
  solicitudId: text(128),
  respuestas: { type: [AnswerSchema], required: true },
  aciertos: int32({ required: true, min: 0, max: 50 }),
  total: int32({ required: true, min: 1, max: 50 }),
  porcentaje: double({ required: true, min: 0, max: 100 }),
  aprobado: { type: Boolean, required: true },
  fecha: { type: Date, required: true },
}, { collection: 'intentos_evaluacion', autoCreate: false, autoIndex: false, versionKey: false, strict: 'throw' });
AttemptSchema.pre('validate', function () {
  try {
    const expected = calculateGrade(this.aciertos, this.total);
    if (!Number.isSafeInteger(this.version) || this.version < 1 || normalizeAnswers(this.respuestas).length !== this.total || Number(this.porcentaje) !== expected.porcentaje || this.aprobado !== expected.aprobado) throw new Error();
  } catch { this.invalidate('respuestas', 'Resultado de intento incoherente'); }
});
AttemptSchema.index({ usuarioId: 1, solicitudId: 1 }, { name: 'usuarioId_1_solicitudId_1', unique: true, collation: { locale: 'simple' } });
AttemptSchema.index({ usuarioId: 1, fecha: -1 }, { name: 'usuarioId_1_fecha_-1' });

// A1 only creates immutable versions and append-only attempts. There is no publication/edit API.
function appendOnly<T>(schema: Schema<T>): void {
  schema.pre('save', function () { if (!this.isNew) throw new Error('Documento histórico inmutable'); });
  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'], function () { throw new Error('Documento histórico inmutable'); });
}
appendOnly(EvaluationSchema);
appendOnly(AttemptSchema);
