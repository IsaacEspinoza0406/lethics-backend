import { Schema, SchemaDefinitionProperty, SchemaTypeOptions } from 'mongoose';
import { Course, CourseModule, Lesson } from '../domain/learning';

// Mongoose 8's number declarations omit Int32 although it works at runtime; same boundary assertion as the assessments schemas.
const int32 = (options: SchemaTypeOptions<number>): SchemaDefinitionProperty<number> => ({ ...options, type: Schema.Types.Int32 }) as unknown as SchemaDefinitionProperty<number>;
const text = (max: number) => ({ type: String, required: true, maxlength: max, match: /\S/ });
const options = (collection: string) => ({ collection, autoCreate: false as const, autoIndex: false as const, versionKey: false as const, strict: 'throw' as const });

const ProjectSchema = new Schema({
  instrucciones: text(20000),
  requisitos: { type: [text(4000)], required: true },
  formatosPermitidos: { type: [text(100)], required: true },
}, { _id: false, strict: 'throw' });
export const CourseSchema = new Schema<Course>({
  titulo: text(300),
  estado: { type: String, required: true, enum: ['borrador', 'publicado'] },
  proyectoFinal: { type: ProjectSchema, required: true },
}, options('cursos'));

export const ModuleSchema = new Schema<CourseModule>({
  cursoId: { type: Schema.Types.ObjectId, ref: 'Curso', required: true },
  orden: int32({ required: true, min: 1 }),
  titulo: text(300),
  activo: { type: Boolean, required: true },
}, options('modulos'));
// Declared for documentation and for explicit index installation; autoIndex stays disabled.
ModuleSchema.index({ cursoId: 1, orden: 1 }, { name: 'cursoId_1_orden_1', unique: true });

// `secciones` is validated by the domain (six block types); Mixed keeps the block union without a collection of its own.
export const LessonSchema = new Schema<Lesson>({
  moduloId: { type: Schema.Types.ObjectId, ref: 'Modulo', required: true },
  orden: int32({ required: true, min: 1 }),
  titulo: text(300),
  version: int32({ required: true, min: 1 }),
  secciones: { type: [Schema.Types.Mixed] as never, required: true },
  activo: { type: Boolean, required: true },
}, options('lecciones'));
LessonSchema.index({ moduloId: 1, orden: 1 }, { name: 'moduloId_1_orden_1', unique: true });
