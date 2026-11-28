import { Schema, SchemaDefinitionProperty } from 'mongoose';
import { LESSON_STATES, LessonProgress } from '../domain/lesson-progress';

// Same Int32 boundary assertion as the content schemas: Mongoose 8 declarations omit it although it works.
const position = { type: Schema.Types.Int32, required: true, min: 0 } as unknown as SchemaDefinitionProperty<number>;

export const LessonProgressSchema = new Schema<LessonProgress>({
  usuarioId: { type: Schema.Types.ObjectId, ref: 'Usuario', required: true },
  leccionId: { type: Schema.Types.ObjectId, ref: 'Leccion', required: true },
  estado: { type: String, required: true, enum: [...LESSON_STATES] },
  puntoActual: position,
  actualizadoEn: { type: Date, required: true },
  completadaEn: { type: Date },
}, { collection: 'progreso_leccion', autoCreate: false, autoIndex: false, versionKey: false, strict: 'throw' });
// Approved index. autoIndex stays disabled: it is installed explicitly, and writes are refused without it.
LessonProgressSchema.index({ usuarioId: 1, leccionId: 1 }, { name: 'usuarioId_1_leccionId_1', unique: true });
