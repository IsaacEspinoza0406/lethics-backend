import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { Attempt, Evaluation } from '../src/modules/assessments/domain/assessment';
import { calculateGrade } from '../src/modules/assessments/domain/grading';
import { assessmentAnswers, assessmentFixture } from './assessment-fixtures';

export type QuizResultRecord = Attempt & { _id: Types.ObjectId; evaluacion: Evaluation & { _id: Types.ObjectId } };
/** Synthetic persisted history, including its exact evaluation version; never academic content. */
export function quizResultFixture(correct = 7, overrides: Partial<Attempt> = {}): QuizResultRecord {
  const evaluacion = { _id: new Types.ObjectId(), ...assessmentFixture({
    cursoId: overrides.cursoId ?? new Types.ObjectId(),
    moduloId: overrides.moduloId === undefined ? new Types.ObjectId() : overrides.moduloId,
    tipo: overrides.moduloId === null ? 'examen_final' : 'cuestionario', version: overrides.version ?? 1,
  }) };
  return { _id: new Types.ObjectId(), usuarioId: new Types.ObjectId(), evaluacionId: evaluacion._id,
    cursoId: evaluacion.cursoId, moduloId: evaluacion.moduloId, version: evaluacion.version,
    solicitudId: randomUUID(), respuestas: assessmentAnswers(correct), ...calculateGrade(correct, 10), fecha: new Date(),
    ...overrides, evaluacion };
}
