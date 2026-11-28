import { Types } from 'mongoose';
import { LessonBlock, MAX_SECTIONS, Stored } from '../../learning/domain/learning';

/** Contract of `progreso_leccion`. A lesson without a record has not been started. */
export const LESSON_STATES = ['en_progreso', 'completada'] as const;
export type LessonState = (typeof LESSON_STATES)[number];

export interface LessonProgress {
  usuarioId: Types.ObjectId;
  leccionId: Types.ObjectId;
  estado: LessonState;
  /** Zero-based index of the last section the student reached. */
  puntoActual: number;
  actualizadoEn: Date;
  completadaEn: Date | null;
}

/**
 * Lessons that carry a simulator or a quiz are completed by sending that activity, never by the student
 * declaring them read. Flashcards are study material and do not change how a lesson is completed.
 */
export function requiredActivity(sections: readonly LessonBlock[]): 'simulador' | 'cuestionario' | undefined {
  for (const block of sections) {
    if (block.tipo === 'recurso' && (block.recurso === 'simulador' || block.recurso === 'cuestionario')) return block.recurso;
  }
  return undefined;
}

const isDate = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime());

export function validLessonProgress(value: unknown): value is Stored<LessonProgress> {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (!(record._id instanceof Types.ObjectId) || !(record.usuarioId instanceof Types.ObjectId) || !(record.leccionId instanceof Types.ObjectId)) return false;
  if (!LESSON_STATES.includes(record.estado as never) || !isDate(record.actualizadoEn)) return false;
  const position = record.puntoActual;
  if (typeof position !== 'number' || !Number.isInteger(position) || position < 0 || position >= MAX_SECTIONS) return false;
  return record.estado === 'completada' ? isDate(record.completadaEn) : record.completadaEn === null;
}
