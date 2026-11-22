import { Types } from 'mongoose';
import { Course, CourseModule, Lesson, LessonBlock, Stored } from '../src/modules/learning/domain/learning';

/** Synthetic content only: it is not (and must not contain) the private academic material. */
export const sampleBlocks = (): LessonBlock[] => [
  { tipo: 'titulo', texto: 'Objetivo sintético' },
  { tipo: 'parrafo', texto: 'Texto sintético de la lección.' },
  { tipo: 'lista', ordenada: true, items: ['Primero', 'Segundo'] },
  { tipo: 'tabla', encabezados: ['Columna A', 'Columna B'], filas: [['a1', 'b1'], ['a2', '']] },
  { tipo: 'destacado', variante: 'nota', texto: 'Nota sintética.' },
  { tipo: 'recurso', recurso: 'flashcards' },
];
export const courseFixture = (overrides: Partial<Course> = {}): Stored<Course> => ({
  _id: new Types.ObjectId(), titulo: 'Curso sintético', estado: 'publicado',
  proyectoFinal: { instrucciones: 'Instrucciones sintéticas.', requisitos: ['Requisito 1'], formatosPermitidos: ['PDF', 'DOCX'] }, ...overrides,
});
export const moduleFixture = (cursoId: Types.ObjectId, orden: number, overrides: Partial<CourseModule> = {}): Stored<CourseModule> =>
  ({ _id: new Types.ObjectId(), cursoId, orden, titulo: `Módulo sintético ${orden}`, activo: true, ...overrides });
export const lessonFixture = (moduloId: Types.ObjectId, orden: number, overrides: Partial<Lesson> = {}): Stored<Lesson> =>
  ({ _id: new Types.ObjectId(), moduloId, orden, titulo: `Lección sintética ${orden}`, version: 1, secciones: sampleBlocks(), activo: true, ...overrides });
